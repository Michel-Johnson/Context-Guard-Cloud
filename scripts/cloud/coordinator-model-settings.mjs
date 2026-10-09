import path from 'node:path';
import { atomicWrite, hash, readJSON, withFileLock } from '../shared/io.mjs';

const fail = (code, message) => { throw Object.assign(new Error(message), { code,
  status: code === 'INVALID_ARGUMENT' ? 400 : ['ID_REUSED', 'VERSION_CONFLICT'].includes(code) ? 409 : 503 }); };
const identifier = value => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(value);

// Browsers select an administrator-configured ID. Private provider files and
// credentials never cross the public settings boundary.
export class CoordinatorModelSettings {
  constructor({ file, options, defaultId, legacyModel, factory }) {
    if (!options.length || options.length > 20 || !options.some(option => option.id === defaultId)) {
      fail('INVALID_COORDINATOR_CONFIG', 'Configure an available default Coordinator model');
    }
    Object.assign(this, { file, options, defaultId, legacyModel, factory });
    this.models = new Map(options.map(option => [option.id, option.model]));
  }
  static async open({ directory, config, factory }) {
    const providers = config.modelProviders || { default: { label: 'Coordinator', providerFile: config.providerFile } };
    if (!providers || Array.isArray(providers) || typeof providers !== 'object') fail('INVALID_COORDINATOR_CONFIG', 'Configure a Coordinator model catalog');
    const options = [];
    let legacyModel;
    try {
      for (const [id, entry] of Object.entries(providers)) {
        if (!identifier(id) || !entry || typeof entry.label !== 'string' || !entry.label.trim() || entry.label.length > 100 || !path.isAbsolute(entry.providerFile || '')) {
          fail('INVALID_COORDINATOR_CONFIG', 'Configure valid Coordinator model entries');
        }
        const provider = await readJSON(entry.providerFile);
        const model = factory(provider);
        const name = model.model || provider.model;
        if (typeof name !== 'string' || !name || config.modelProviders && model.model !== name) fail('INVALID_COORDINATOR_CONFIG', 'Configured Coordinator model has no identity');
        options.push({ id, label: entry.label, name, config: provider, model });
        if (entry.providerFile === config.providerFile) legacyModel = model;
      }
      if (!legacyModel) legacyModel = factory(await readJSON(config.providerFile));
    } catch {
      // Parsing errors may contain private values; report a stable safe error.
      fail('INVALID_COORDINATOR_CONFIG', 'Configured Coordinator model is unavailable');
    }
    return new CoordinatorModelSettings({ file: path.join(directory, 'model-settings.json'), options,
      defaultId: config.defaultProviderId || options.find(option => option.model === legacyModel)?.id || options[0]?.id,
      legacyModel, factory });
  }
  async read() {
    const state = await readJSON(this.file, { selectedId: this.defaultId, revision: 0, receipts: {} });
    if (!this.models.has(state.selectedId) || !Number.isSafeInteger(state.revision) || state.revision < 0 || !state.receipts || typeof state.receipts !== 'object') {
      fail('MODEL_SETTINGS_UNAVAILABLE', 'Saved Coordinator model is unavailable');
    }
    return state;
  }
  public(state) {
    return { version: hash(JSON.stringify({ selectedId: state.selectedId, revision: state.revision })), selectedId: state.selectedId,
      options: this.options.map(option => ({ id: option.id, label: option.label, model: option.name })) };
  }
  async state() { return this.public(await this.read()); }
  async selection(overrides = null) {
    const state = await this.read();
    const option = this.options.find(item => item.id === state.selectedId);
    return { providerId: option.id, version: this.public(state).version, model: overrides ? this.factory({ ...option.config, ...overrides }) : option.model };
  }
  async selectForTurn(input) {
    const receipt = await this.select(input), current = await this.state();
    const historical = receipt.version !== current.version;
    return { kind: 'model-selected', label: current.options.find(option => option.id === current.selectedId).label,
      ...(historical ? { receiptLabel: receipt.options.find(option => option.id === receipt.selectedId).label } : {}),
      status: historical ? 'historical-receipt' : 'applied', effective: historical ? 'historical-only' : 'next-text-turn' };
  }
  async select(input) {
    if (!input || Object.keys(input).some(key => !['id', 'providerId', 'baseVersion'].includes(key)) ||
        !identifier(input.id) || !identifier(input.providerId) || typeof input.baseVersion !== 'string' || !/^[a-f0-9]{64}$/.test(input.baseVersion)) {
      fail('INVALID_ARGUMENT', 'Select a configured model with the current settings version');
    }
    if (!this.models.has(input.providerId)) fail('INVALID_ARGUMENT', 'Selected Coordinator model is not configured');
    return withFileLock(this.file + '.lock', async () => {
      const state = await this.read();
      const fingerprint = hash(JSON.stringify([input.id, input.providerId, input.baseVersion]));
      const receiptId = hash(input.id);
      const previous = state.receipts[receiptId];
      if (previous) {
        if (previous.fingerprint !== fingerprint) fail('ID_REUSED', 'Model selection request differs');
        return previous.result;
      }
      if (input.baseVersion !== this.public(state).version) fail('VERSION_CONFLICT', 'Model settings changed; reload before selecting');
      state.selectedId = input.providerId;
      state.revision++;
      const result = this.public(state);
      state.receipts[receiptId] = { fingerprint, result, at: new Date().toISOString() };
      await atomicWrite(this.file, JSON.stringify(state, null, 2) + '\n');
      return result;
    });
  }
}
