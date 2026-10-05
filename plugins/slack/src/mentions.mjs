// Only native mentions in the current message can address the Coordinator.
// Quoted history and code remain context, not routing instructions.
export function activeMentions(text) {
  const current = String(text || '').replace(/```[\s\S]*?(?:```|$)/g, '')
    .replace(/`[^`\n]*(?:`|$)/g, '').replace(/^\s*(?:>|&gt;).*$/gm, '');
  return [...new Set([...current.matchAll(/<@([UW][A-Z0-9]+)(?:\|[^>]+)?>/g)].map(match => match[1]))];
}
export function explicitlyAddressed(event, botUserId) {
  // Synthetic slash/shortcut entries are created by this plugin, not Slack.
  return event.type === 'app_mention' && event.ts?.startsWith('command-') || activeMentions(event.text).includes(botUserId);
}
