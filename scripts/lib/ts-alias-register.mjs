// Registers the `@shared/*` resolver before the test imports production
// modules. Used by `npm run test:read-only`.
import { register } from 'node:module'

register(new URL('./ts-alias-hooks.mjs', import.meta.url))
