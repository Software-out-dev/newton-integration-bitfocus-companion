import type { CompanionStaticUpgradeScript } from '@companion-module/base'
import type { ModuleConfig } from './config.js'

// Once an upgrade script is added here it can never be removed
// (Companion tracks how many scripts have run per connection).
export const UpgradeScripts: CompanionStaticUpgradeScript<ModuleConfig>[] = []
