import { tbc } from './tbc.js';
import { bog } from './bog.js';
import { credo } from './credo.js';
import { keepz } from './keepz.js';

const providers = { tbc, bog, credo, keepz };
export function providerFor(bank) {
  const provider = providers[bank];
  if (!provider) throw new Error('Unsupported bank');
  return provider;
}
