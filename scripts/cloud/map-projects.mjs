import { createHash } from 'node:crypto';
import { entries, MapError } from '../shared/map-model.mjs';

const hash = text => createHash('sha256').update(text).digest('hex');
export const mapProjectId = nodeId => `map-${hash(nodeId).slice(0, 48)}`;
export const isMapProject = project => typeof project?.mapNodeId === 'string';

// Map remains authoritative. Only conversation state is persisted separately;
// no registry entry, repository binding or second Map is created here.
export class MapProjects {
  constructor({ config, readOverview, registeredProjects, memoryConfig }) {
    Object.assign(this, { config, readOverview, registeredProjects, memoryConfig });
  }
  allowed(actor) {
    return !!this.config && actor?.integration === 'slack' && this.config.userIds.includes(actor.userId);
  }
  async projects() {
    if (!this.config) return [];
    const { document } = await this.readOverview();
    const registered = new Map(this.registeredProjects().map(project => [project.id, project]));
    return (document?.root?.children || []).flatMap(node => {
      const linked = node.cloudProjectId || (node.id.startsWith('P_') ? node.id.slice(2) : null);
      if (linked) {
        const project = registered.get(linked);
        return project && this.memoryConfig?.projects?.[linked]?.coordinator?.enabled
          ? [{ ...project, name: node.title, description: node.purpose || '' }] : [];
      }
      const id = mapProjectId(node.id);
      if (registered.has(id)) throw new MapError('PROJECT_ID_CONFLICT', 'Map 项目与既有项目身份冲突', 409);
      return [{ id, name: node.title, description: node.purpose || '', mapNodeId: node.id }];
    });
  }
  async get(id) {
    const project = (await this.projects()).find(project => project.id === id);
    if (!project) throw new MapError('NOT_FOUND', '项目已删除或停止开放，请重新选择', 404);
    return project;
  }
  coordinatorConfig() {
    const source = this.memoryConfig?.projects?.[this.config?.coordinatorProjectId]?.coordinator;
    if (!source?.enabled) throw new MapError('COORDINATOR_DISABLED', 'Map 项目的默认 Coordinator 尚未配置', 503);
    // Inherit model configuration, never repository/Session/file permissions.
    return { enabled: true, providerFile: source.providerFile, modelProviders: source.modelProviders,
      defaultProviderId: source.defaultProviderId, simulated: source.simulated === true,
      bindings: {}, sessionTemplates: [], mapWrite: true, fileWrite: false };
  }
  async read(id) {
    const project = await this.get(id);
    if (!isMapProject(project)) throw new MapError('INVALID_PROJECT', '此入口使用既有项目存储', 400);
    const snapshot = await this.readOverview();
    const node = snapshot.document.root.children.find(node => node.id === project.mapNodeId);
    if (!node) throw new MapError('NOT_FOUND', '项目已删除，请重新选择', 404);
    const ids = new Set(entries(node).keys());
    const document = { v: snapshot.document.v || 1, project: node.title, root: structuredClone(node),
      ...(snapshot.document.flows ? { flows: snapshot.document.flows.filter(flow =>
        ids.has(flow.from) && ids.has(flow.to)) } : {}) };
    return { revision: 0, main: { version: snapshot.version, memory: { map: document, records: {} } },
      sessions: {}, closedSessions: {}, receipts: {}, history: [], events: [], eventCursors: {} };
  }
}
