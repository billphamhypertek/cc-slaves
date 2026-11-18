// §6B / §7.2 N2: on the remote channel the UI hides what the engine would refuse (`forbidden_remote`).
import { CARD_ACTION_CMD, REMOTE_ALLOWED, type CardView, type Channel, type Command } from '../../../shared/protocol.ts';

export const canRun = (channel: Channel | null, cmd: Command['cmd']) => channel === 'mac' || REMOTE_ALLOWED.has(cmd);

/** A card button this channel may press (C24: a Mac-only command is refused remotely). */
export const actionAllowed = (id: string, channel: Channel | null) => { const cmd = CARD_ACTION_CMD[id]; return !cmd || canRun(channel, cmd); };

export const cardActions = (c: CardView, channel: Channel | null) => (c.actions ?? []).filter(a => actionAllowed(a.id, channel));
