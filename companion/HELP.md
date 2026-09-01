# Outline Newton

Control the Outline Newton audio signal matrix and hub from Bitfocus Companion.

## Configuration

- **Device IP Address**: the Newton's IP address.
- **Meter/status polling interval (ms)**: how often Companion queries the VU meters and the live priority-patch/clock status over UDP `6667`. Default `100` ms = 10 queries per second; allowed range `80..1000` ms. Lower values give smoother meters and faster status monitors at the cost of more network traffic. Applying a new value recreates the UDP meter socket immediately; the TCP session is not touched.
- **Gain/Mute refresh interval (ms)**: how often the gain/mute state is re-read from the full audio-preset payload (`0x21`, ~384 KiB per response) over TCP. Default `1500` ms = one read every 1.5 s (~256 KiB/s of payload while active); allowed range `1000..5000` ms. Periodic refresh runs only while at least one gain/mute feedback is in use, so buttons without Levels & Mute feedbacks cause no background `0x21` polling.

Out-of-range or invalid interval values are clamped back to these ranges at runtime; saving a config that changes only the intervals never restarts the TCP session.

Companion sends commands, configuration reads and snapshot traffic to Newton over TCP port `6668`. Real-time meter/status requests use UDP port `6667`; the operating system automatically chooses Companion's local UDP reply port.

All channel and input numbers shown in Companion are 1-based. The module converts them internally to Newton's 0-based protocol indices before sending a command.

The UDP stream also carries the live priority-patch and clock status. If UDP `6667` is blocked between Companion and the Newton, control over TCP keeps working, but meters and the priority/clock monitors stay `N/A` and the module logs a warning — check the network path in that case.

## Input patch

Priority-source monitoring and rearming for inputs `1..16`:

- **Monitor Input**: set one value, "Input (1-16)", in the feedback. The button shows `IN <n>` and turns green while the input's top-priority source is playing, orange when a backup source has taken over, grey when unknown.
- **Rearm Input**: set the input number in the label feedback. The button shows `REARM IN <n>`; pressing it puts the input back on its top-priority source.
- **Rearm All Inputs**: rearms all 16 inputs with one press.
- **Read Priority List**: reads one input's priority source list from the device without changing anything. Useful in triggers or for diagnostics; the outcome appears in the `last_action_*` variables.

Some firmware doesn't report the priority list; the monitor button then stays grey.

## Clock

Same workflow as Input patch, for the processing clocks (Master Clock, Word Clock Out 1, Word Clock Out 2):

- **Monitor Clock**: select the clock in the feedback. The button shows the clock and its current source (e.g. `MCLK / WC`), green while its top-priority clock is running, orange when a backup has taken over.
- **Rearm Clock**: select the clock in the label feedback; the button shows `REARM <clock>` and pressing it puts the clock back on its top-priority source.

## Levels & Mute

Set the channel type (Input DSP or Output DSP) and the channel number `1..16` in the options:

- **Channel Gain**: shows the channel's live gain, e.g. `GAIN IN 3 / -6.0 dB` (or `MUTED`).
- **Channel Mute**: a mute key. Shows `TOGGLE MUTE / IN 3 / UNMUTED` (green) or `MUTED` (red); pressing it toggles the mute, keeping the current gain. One pair of options drives both the state and the press.
- **Level Up / Level Down**: raise or lower the gain by a chosen dB amount (0.1-24 dB per press), keeping mute. Limited to `-80..+6 dB`.

**Channel Mute (set/toggle)** sets, clears or toggles mute on an Input/Output DSP channel `1..16` without touching its gain, and needs no feedback on the button.

**Set Gain and Mute State** is available when a fixed value is required. It supports all documented processing banks; Companion always displays one-based numbers and sends Newton the corresponding zero-based index.

| Channel type | Channel in Companion | Index sent to Newton |
| ------------ | -------------------- | -------------------- |
| Input DSP    | `1..16`              | `0..15`              |
| Output DSP   | `1..16`              | `0..15`              |
| Aux Mixer    | `1..10`              | `0..9`               |
| Matrix Mixer | `1..288`             | `0..287`             |
| Trimmer      | `1..64`              | `0..63`              |
| Output Group | `1..64`              | `0..63`              |

Every gain the module writes is hard-clamped to the device-safe `-80..+6 dB` window: values outside this range never reach the device.

Gain and mute feedbacks refresh from the complete Newton audio-preset payload (`0x21`) while at least one Levels & Mute feedback is in use. The **Gain/Mute refresh interval** setting controls this background cadence, so changes made elsewhere (another controller, the front panel, a snapshot recall) appear automatically. Before a relative gain or mute write, Companion reads the current device state and serializes same-channel presses, so it does not reuse stale gain/mute values. Values show `--` until first read or while disconnected.

## Snapshots

**Apply Snapshot**: pick the snapshot by name in the label feedback; the button shows the snapshot name and pressing it applies it, with the fading time and transition mode set in the action options. The name list is read from the device when the module connects. A dropdown action, "Snapshot Apply (by name)", is also available for triggers. Run **Refresh Snapshot Database** after snapshots are added, renamed or removed outside Companion.

The **fading time** must be `0` (apply instantly) or between `2000` and `65535` ms: Newton does not support fades of 1-1999 ms, and the module rejects such values with a log message instead of sending them.

Snapshots require Newton **firmware 0.98 or later**. The module reads the firmware version when it connects: on older firmware (e.g. 0.97) the snapshot actions are disabled with a clear log message, the snapshot button label shows `NO SNAPSHOT / FW < 0.98`, and `$(outline-newton:snapshot_support)` reads `Unsupported by firmware`. Every other feature keeps working.

## Metering

**Meter**: a full-height meter button. Pick the meter type (Input DSP or Output DSP), the mode (Peak or RMS) and the channel `1..16`. The bar fills the left half with an LED-segment look; the right column reads `VU`, `IN`/`OUT`, the channel number and `RMS`/`PK`. Meter data is queried from Newton's UDP server on port `6667`; the operating system chooses the local reply port. These samples are independent of commands and audio-preset reads sent over TCP port `6668`.

Bands: below `-60 dB` everything is dark; from `-60` to `-40` only the blue signal LED lights; from `-40` to `0 dB` the green→yellow→red bar lights proportionally, turning yellow at `-12 dB` and red at `-6 dB`.

Per-channel values are also published as `$(outline-newton:vu_input_1)`..`vu_input_16` and `vu_output_1`..`vu_output_16`.

## Status

- **Connection Status**: shows `NEWTON ONLINE` (green) or `OFFLINE` (red).
- Boolean **Device Connected** and **Last Action Success/Error** feedbacks are available for triggers.

The optional "Action name" filter of the Last Action feedbacks matches the action name exactly as shown in the actions list (for example `Set Gain and Mute State`, `Snapshot Apply (by name)`, `Rearm Priority Patch`, `Level Up / Down`); leave it blank to match any action.

## Variables

- `$(outline-newton:connection_state)`: `Connected` or `Disconnected`.
- `$(outline-newton:priority_input_1)`..`priority_input_16` and `priority_aux_input_1`..`priority_aux_input_8`: active source per priority patch, shown with 1-based source numbering (`N/A` when Newton reports no source).
- `$(outline-newton:vu_input_1)`..`vu_input_16` and `vu_output_1`..`vu_output_16`: per-channel **peak** meter levels in dB (1-based). RMS is only available through the Meter feedback's drawn image, not as a variable.
- `$(outline-newton:snapshot_support)`: `OK`, `Unknown` or `Unsupported by firmware` (firmware < 0.98).
- `$(outline-newton:vu_format)`: VU stream status. Reads `status-1024-peak-rms-db` while UDP meter packets are being decoded, otherwise the loss reason (`No VU packets` or `UDP error: …`).
- `$(outline-newton:device_name)`, `firmware_version`, `serial_number`: device identity, re-read on every connection (`Unknown` until the device answers).
- `$(outline-newton:snapshot_count)`, `last_applied_snapshot`, `last_snapshot_response`: snapshot database size and the outcome of the last snapshot operation.
- `$(outline-newton:last_action_name)`, `last_action_status`, `last_action_response_hex`: the most recent action run from any button, its result (`success`/`error`/`unknown`) and the device reply.
- `$(outline-newton:last_command)`, `last_response_hex`: the most recent protocol command, including background polling, and its reply.
- `$(outline-newton:last_error)`: the last error message, cleared by the next successful command.
- `$(outline-newton:last_priority_update)`, `last_vu_update`: timestamps of the last priority change and of the last meter packet in the current stream (`Never` until one arrives, and again whenever the UDP stream is lost).

The `*_response_hex`, `last_snapshot_response` and `last_applied_snapshot` variables summarize large protocol replies rather than publishing them in full.
