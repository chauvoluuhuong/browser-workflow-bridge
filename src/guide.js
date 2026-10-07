// What is missing and what the user does about it, in words Claude can pass on. The bridge can only
// speak when Claude calls one of its tools, so `bridge_status` ends with these steps whenever the
// bridge is not connected: no token yet, a server that doesn't answer, a token the server refused.
export const PRODUCTION = 'https://browser-workflow-294054962898.us-central1.run.app';
const PLUGIN = 'browser-workflow-bridge';

const CONFIGURE = `/plugin configure ${PLUGIN}`;
const CONNECT = 'run /mcp, choose "browser-workflow", then Authenticate (on the page that opens, Continue is enough; an account can come later)';

/** True for an address on this computer: a server someone runs for development. */
export function isLocal(server) {
  try {
    return ['localhost', '127.0.0.1', '[::1]'].includes(new URL(server).hostname);
  } catch {
    return false;
  }
}

/** Does anything answer at the server's address? Undefined when it can't be told in time. */
export async function reachable(server, timeoutMs = 3000) {
  try {
    const res = await fetch(`${server.replace(/\/+$/, '')}/health`, { signal: AbortSignal.timeout(timeoutMs) });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * The steps for the user, as lines. Empty when the bridge is connected and nothing is to be done.
 * @param {{ state: string, server: string, token: boolean, lastError?: string, serverUp?: boolean }} s
 */
export function nextSteps(s) {
  const down = s.serverUp === false;
  const serverDown = isLocal(s.server)
    ? [
      `Nothing answers at ${s.server}. That is a development address: start the server there (from the browser-workflow repo),`,
      `or go back to the hosted server: run ${CONFIGURE} and set Server to ${PRODUCTION}.`,
    ]
    : [`${s.server} does not answer. Check the internet connection; the bridge keeps trying by itself.`];

  if (s.state === 'connected') return [];
  if (s.state === 'paused') return ['The bridge is paused. Ask to resume it (bridge_status with action "resume").'];
  if (s.state === 'not_configured') {
    return [
      'The bridge is installed but not linked to a Browser Workflow account yet. Tell the user these steps:',
      ...(down ? ['Before anything else:', ...serverDown.map((l) => `   ${l}`)] : []),
      `1. Connect to Browser Workflow: ${CONNECT}.`,
      '2. Ask Claude "show my browser-workflow account", and in the view that appears click "New bridge token". Copy the token.',
      `3. Run ${CONFIGURE} and paste it as "Bridge token".`,
      '4. Start a new Claude Code session, then ask "check the bridge status".',
    ];
  }
  if (s.state === 'rejected') {
    return [
      `The server refused this bridge${s.lastError ? `: ${s.lastError}` : '.'}`,
      'If another computer is now this account\'s bridge, resume here to take it back (bridge_status with action "resume").',
      `If the token was replaced: ask Claude "show my browser-workflow account", click "New bridge token", paste it with ${CONFIGURE}, and start a new session.`,
    ];
  }
  // connecting, or disconnected and retrying
  if (down || /could not reach/i.test(s.lastError ?? '')) return serverDown;
  return [];
}

/** For a connected bridge whose connector Claude can't use yet: the one thing left to check. */
export const CONNECTOR_HINT = `If the browser-workflow tools (list_workflows, run_workflow…) are missing in this session: ${CONNECT}.`;

/** Given to Claude when the bridge starts (MCP instructions). */
export const INSTRUCTIONS = [
  'The Browser Workflow bridge runs the user\'s browser-workflow automations in their own Chrome.',
  'When a browser-workflow tool says the bridge is not connected, when those tools are missing, or when the user asks to set Browser Workflow up, call bridge_status:',
  'it says what is missing and gives the steps for the user. Pass those steps on as they are; never ask the user to paste a token into the chat.',
].join(' ');
