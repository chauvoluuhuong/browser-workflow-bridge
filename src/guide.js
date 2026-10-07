// What is missing and what to do about it, in words Claude can pass on. The app can only speak when
// Claude calls one of its tools, so `bridge_status` ends with these steps whenever the app is not
// connected: not linked to an account yet (the usual first start), the server not answering, or the
// server having refused this computer.
export const PRODUCTION = 'https://browser-workflow-294054962898.us-central1.run.app';
const PLUGIN = 'browser-workflow-bridge';

const CONFIGURE = `/plugin configure ${PLUGIN}`;

/** True for an address on this computer: a server someone runs for development. */
export function isLocal(server) {
  try {
    return ['localhost', '127.0.0.1', '[::1]'].includes(new URL(server).hostname);
  } catch {
    return false;
  }
}

/** Does anything answer at the server's address? */
export async function reachable(server, timeoutMs = 3000) {
  try {
    const res = await fetch(`${server.replace(/\/+$/, '')}/health`, { signal: AbortSignal.timeout(timeoutMs) });
    return res.ok;
  } catch {
    return false;
  }
}

/** How to add the connector, where the user is: the part Claude can't do for them. */
export function connectorSteps(server) {
  return [
    `   - Claude chat (the desktop app): Settings → Connectors → Add custom connector, address ${server}/mcp, then Continue on the page that opens.`,
    '   - Claude Code: run /mcp, choose "browser-workflow", then Authenticate (Continue is enough).',
  ];
}

/**
 * The steps, as lines. Empty when the app is connected and nothing is to be done.
 * @param {{
 *   state: string, server: string, token: boolean, lastError?: string, serverUp?: boolean,
 *   pairing?: { state: string, code?: string, expiresAt?: number, lastError?: string },
 * }} s
 */
export function nextSteps(s) {
  const down = s.serverUp === false || (s.serverUp === undefined && s.pairing?.state === 'unreachable');
  const serverDown = isLocal(s.server)
    ? [
      `Nothing answers at ${s.server}. That is a development address: start the server there (from the browser-workflow repo),`,
      `or go back to the hosted server: run ${CONFIGURE} and set Server to ${PRODUCTION}.`,
    ]
    : [`${s.server} does not answer. Check the internet connection; the app keeps trying by itself.`];

  if (s.state === 'connected') return [];
  if (s.state === 'paused') return ['The app is paused. Ask to resume it (bridge_status with action "resume").'];
  if (s.state === 'not_configured') {
    // The server is there but refused the pairing request: an app newer than the server, most likely.
    if (s.serverUp !== false && s.pairing?.state === 'unreachable') return [`The server answers, but not to the pairing request${s.pairing.lastError ? ` (${s.pairing.lastError})` : ''}. Try again in a minute; if it keeps failing, the server needs updating.`];
    if (down || !s.pairing?.code) return down ? serverDown : ['Getting a pairing code from the server… call bridge_status again in a few seconds.'];
    const minutes = Math.max(1, Math.round(((s.pairing.expiresAt ?? 0) - Date.now()) / 60_000));
    return [
      `This computer is not linked to a Browser Workflow account yet. Pairing code: ${s.pairing.code} (valid for about ${minutes} more minutes).`,
      'Claude does the linking; the user only clicks one button:',
      `1. Call the Browser Workflow tool \`link_computer\` with code "${s.pairing.code}". It shows the user a "Link this computer" button.`,
      '2. Ask the user to click it, then call bridge_status again: it should say connected.',
      'If there is no `link_computer` tool, the Browser Workflow connector is not added yet. Tell the user to add it, then call `link_computer`:',
      ...connectorSteps(s.server),
    ];
  }
  if (s.state === 'rejected') {
    return [
      `The server refused this computer${s.lastError ? `: ${s.lastError}` : '.'}`,
      'If another computer is now this account\'s browser, resume here to take it back (bridge_status with action "resume").',
    ];
  }
  // connecting, or disconnected and retrying
  if (down || /could not reach/i.test(s.lastError ?? '')) return serverDown;
  return [];
}

/** For a connected app whose connector Claude can't use yet: the one thing left to check. */
export function connectorHint(server) {
  return ['If the browser-workflow tools (list_workflows, run_workflow…) are missing in this session, the connector is not added yet:', ...connectorSteps(server)].join('\n');
}

/** Given to Claude when the app starts (MCP instructions). */
export const INSTRUCTIONS = [
  'This app runs the user\'s Browser Workflow automations in their own Chrome. It is the local half of the Browser Workflow connector.',
  'When a browser-workflow tool says the browser is not connected, when the user asks to set Browser Workflow up, or when a run could not start, call bridge_status.',
  'If it shows a pairing code, call the Browser Workflow tool link_computer with that code: the user then clicks one button. Never ask the user to copy a code or a token themselves.',
].join(' ');
