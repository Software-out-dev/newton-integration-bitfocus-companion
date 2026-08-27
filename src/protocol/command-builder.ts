import {
	CLOCK_LIST_LENGTH,
	ClockType,
	FIXED_BYTE_0x33,
	FIXED_BYTE_0x66,
	LegacyCmd,
	clampGainDb,
	SPC_CRC_SIZE,
	SPC_HEADER,
	SPC_HEADER_SIZE,
	SNAPSHOT_MAX_PAYLOAD_BYTES,
	SnapshotCmd,
} from './constants.js'
import { appendCrc16 } from './crc16.js'
import type { GainParams, SnapshotApplyParams } from './types.js'

// ===== Legacy Commands =====

/**
 * Build a Gain command (0x01) - 11 bytes total.
 * [0]: cmd 0x01
 * [1]: channel type
 * [2-5]: channel index (int32 LE)
 * [6-9]: gain in dB (float32 LE), clamped to the device-safe write range
 * [10]: mute (0=no mute, 1=mute)
 */
export function buildGainCommand(params: GainParams): Buffer {
	const buf = Buffer.alloc(11)
	buf[0] = LegacyCmd.Gain
	buf[1] = params.channelType
	buf.writeInt32LE(params.channelIndex, 2)
	buf.writeFloatLE(clampGainDb(params.gainDb), 6)
	buf[10] = params.mute ? 1 : 0
	return buf
}

/**
 * Build an Import Description command (0x3E) - 3 bytes total.
 * Reads the device description.
 */
export function buildImportDescriptionCommand(): Buffer {
	const buf = Buffer.alloc(3)
	buf[0] = LegacyCmd.ImportDescription
	buf[1] = FIXED_BYTE_0x33
	buf[2] = FIXED_BYTE_0x66
	return buf
}

/**
 * Build an Import Firmware version command (0x40) - 3 bytes total.
 */
export function buildImportFirmwareCommand(): Buffer {
	const buf = Buffer.alloc(3)
	buf[0] = LegacyCmd.ImportFirmware
	buf[1] = FIXED_BYTE_0x33
	buf[2] = FIXED_BYTE_0x66
	return buf
}

/**
 * Build an Import Serial command (0x37) - 3 bytes total.
 */
export function buildImportSerialCommand(): Buffer {
	const buf = Buffer.alloc(3)
	buf[0] = LegacyCmd.ImportSerial
	buf[1] = FIXED_BYTE_0x33
	buf[2] = FIXED_BYTE_0x66
	return buf
}

/**
 * Build an Import Audio Preset command (0x21) - 3 bytes total.
 * The response is [0x33, 0x00] followed by the full 393216-byte audio preset,
 * which carries every processing parameter (gains, mutes, filters, ...).
 */
export function buildImportAudioPresetCommand(): Buffer {
	const buf = Buffer.alloc(3)
	buf[0] = LegacyCmd.ImportAudioPresetInfo
	buf[1] = FIXED_BYTE_0x33
	buf[2] = FIXED_BYTE_0x66
	return buf
}

/**
 * Build an Import Signals command (0x2B) - 3 bytes total.
 * Reads the 1024-byte signals/LEDs blob.
 * Bytes [666-689] contain the current source channel for each priority patch.
 */
export function buildImportSignalsCommand(): Buffer {
	const buf = Buffer.alloc(3)
	buf[0] = LegacyCmd.ImportSignals
	buf[1] = FIXED_BYTE_0x33
	buf[2] = FIXED_BYTE_0x66
	return buf
}

/**
 * Build a Read Hardware-to-Logic priority list command (0x91) - 4 bytes total.
 * [0]: cmd 0x91
 * [1]: 0x33 fixed
 * [2]: 0x66 fixed
 * [3]: InputDsp channel index (0..15)
 *
 * Response contains the priority list for the requested channel:
 * highest priority ch, 2nd, 3rd, lowest priority ch, isForced, forced ch.
 */
export function buildReadPriorityListCommand(channelIndex: number): Buffer {
	const buf = Buffer.alloc(4)
	buf[0] = LegacyCmd.ReadPriorityList
	buf[1] = FIXED_BYTE_0x33
	buf[2] = FIXED_BYTE_0x66
	buf[3] = channelIndex & 0xff
	return buf
}

/**
 * Build a Hardware-to-Logic priority update/rearm command (0x90) - 12 bytes.
 * [0]: cmd 0x90
 * [1]: 0x33 fixed
 * [2]: 0x66 fixed
 * [3]: InputDsp channel index (0..15)
 * [4-7]: four priority sources from highest to lowest
 * [8]: retain forced/manual mode from the preceding 0x91 read
 * [9]: retain forced channel from the preceding 0x91 read
 * [10]: rearm flag (1)
 * [11]: rearm slot (0..3)
 *
 * The protocol has no short "rearm" form: callers must read the current
 * list first and preserve its priority/forced bytes in this full update.
 */
export function buildRearmPriorityCommand(
	channelIndex: number,
	priority: { sources: number[]; isForced: boolean; forcedChannel: number },
	rearmIndex: number,
): Buffer {
	if (priority.sources.length !== 4) {
		throw new Error('Priority list must contain exactly four source channels')
	}
	const buf = Buffer.alloc(12)
	buf[0] = LegacyCmd.RearmPriority
	buf[1] = FIXED_BYTE_0x33
	buf[2] = FIXED_BYTE_0x66
	buf[3] = channelIndex & 0xff
	for (let i = 0; i < 4; i++) buf[4 + i] = priority.sources[i] & 0xff
	buf[8] = priority.isForced ? 1 : 0
	buf[9] = priority.forcedChannel & 0xff
	buf[10] = 1
	buf[11] = rearmIndex & 0xff
	return buf
}

/**
 * Build a Get Processing Clock command (0x81) - 4 bytes total.
 * [0]: cmd 0x81
 * [1]: 0x33 fixed
 * [2]: 0x66 fixed
 * [3]: clock type (0=Master, 1=Word Clock Out 1, 2=Word Clock Out 2)
 *
 * Response is 19 bytes: [0-15] priority list (Clock List values),
 * [16] isForced, [17] forced index into the list, [18] is48.
 */
export function buildGetClockCommand(clockType: ClockType): Buffer {
	const buf = Buffer.alloc(4)
	buf[0] = LegacyCmd.GetProcessingClock
	buf[1] = FIXED_BYTE_0x33
	buf[2] = FIXED_BYTE_0x66
	buf[3] = clockType & 0xff
	return buf
}

/**
 * Build a processing-clock rearm command (0x80) - 25 bytes total.
 * [0]: cmd 0x80
 * [1]: 0x33 fixed
 * [2]: 0x66 fixed
 * [3]: clock type
 * [4-19]: 16-byte priority list, preserved from the preceding 0x81 read
 * [20]: isForced (preserved)
 * [21]: forced clock VALUE per Clock List (0x81 returns an index; convert)
 * [22]: is48 (preserved)
 * [23]: isRearm = 1
 * [24]: rearm slot (0..13)
 *
 * Like H2L, the protocol has no short rearm form: the current settings are
 * read first and written back unchanged with the rearm flag set.
 */
export function buildRearmClockCommand(
	clockType: ClockType,
	clock: { list: number[]; isForced: boolean; forcedIndex: number; is48: boolean },
	rearmIndex: number,
): Buffer {
	if (clock.list.length !== CLOCK_LIST_LENGTH) {
		throw new Error('Clock priority list must contain exactly 16 entries')
	}
	if (
		clock.isForced &&
		(!Number.isInteger(clock.forcedIndex) || clock.forcedIndex < 0 || clock.forcedIndex >= CLOCK_LIST_LENGTH)
	) {
		throw new RangeError(`Forced clock index must be between 0 and ${CLOCK_LIST_LENGTH - 1}`)
	}
	const buf = Buffer.alloc(25)
	buf[0] = LegacyCmd.SetProcessingClock
	buf[1] = FIXED_BYTE_0x33
	buf[2] = FIXED_BYTE_0x66
	buf[3] = clockType & 0xff
	for (let i = 0; i < CLOCK_LIST_LENGTH; i++) buf[4 + i] = clock.list[i] & 0xff
	buf[20] = clock.isForced ? 1 : 0
	buf[21] = clock.isForced ? clock.list[clock.forcedIndex] & 0xff : 0
	buf[22] = clock.is48 ? 1 : 0
	buf[23] = 1
	buf[24] = rearmIndex & 0xff
	return buf
}

// ===== Special Protocol Commands (SPC) =====

/**
 * Build a generic SPC (Special Protocol Command) message.
 *
 * Structure:
 * [0]: 0xF0 (SPC header)
 * [1]: 0x00 (empty)
 * [2-3]: CMD (16bit MSB first)
 * [4-5]: LEN (total message length, 16bit MSB first)
 * [6..N-3]: payload
 * [N-2..N-1]: CRC16 (LSB first)
 */
export function buildSPC(specialCmd: SnapshotCmd, jsonPayload?: Record<string, unknown>): Buffer {
	const payloadStr = jsonPayload ? JSON.stringify(jsonPayload) : ''
	const payloadBuf = Buffer.from(payloadStr, 'utf-8')
	if (payloadBuf.length > SNAPSHOT_MAX_PAYLOAD_BYTES) {
		throw new RangeError(`SPC payload exceeds the snapshot limit (${payloadBuf.length} bytes)`)
	}

	const totalLen = SPC_HEADER_SIZE + payloadBuf.length + SPC_CRC_SIZE
	if (totalLen > 0xffff) {
		throw new RangeError(`SPC payload exceeds the 16-bit frame limit (${totalLen} bytes)`)
	}
	const buf = Buffer.alloc(totalLen)

	// Header
	buf[0] = SPC_HEADER
	buf[1] = 0x00
	// CMD - MSB first
	buf.writeUInt16BE(specialCmd, 2)
	// LEN - MSB first (total message length)
	buf.writeUInt16BE(totalLen, 4)

	// Payload
	if (payloadBuf.length > 0) {
		payloadBuf.copy(buf, SPC_HEADER_SIZE)
	}

	// CRC16 (LSB first) - calculated over everything except the CRC bytes
	appendCrc16(buf)

	return buf
}

/**
 * Build a Snapshot Get Database command.
 * Retrieves the full snapshot database from the device.
 */
export function buildSnapshotGetDatabase(): Buffer {
	return buildSPC(SnapshotCmd.GetDatabase)
}

/**
 * Build a Snapshot Apply command.
 * Applies a snapshot with optional fading time, mode, and partial recall.
 */
export function buildSnapshotApply(params: SnapshotApplyParams): Buffer {
	const payload: Record<string, unknown> = { uuid: params.uuid }
	if (params.fadingTime !== undefined) {
		payload.fading_time = params.fadingTime
	}
	if (params.mode !== undefined) {
		payload.mode = params.mode
	}
	if (params.parts !== undefined) {
		payload.part = params.parts
	}
	return buildSPC(SnapshotCmd.Apply, payload)
}
