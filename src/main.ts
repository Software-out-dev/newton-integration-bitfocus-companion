import { runEntrypoint } from '@companion-module/base'
import { NewtonInstance } from './instance.js'
import { UpgradeScripts } from './upgrades.js'

runEntrypoint(NewtonInstance, UpgradeScripts)
