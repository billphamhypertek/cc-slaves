// v2 §6A the `vi` catalog: one JSON per namespace, merged into flat `<ns>.<path>` keys (the source language).
// Loaded with the first paint (default language).
// How to add a key / namespace: docs/ref/i18n.md.
import { addCatalog } from './core.ts';
import accounts from './vi/accounts.json';
import common from './vi/common.json';
import settings from './vi/settings.json';
import topbar from './vi/topbar.json';
import wizard from './vi/wizard.json';
import format from './vi/format.json';
import roles from './vi/roles.json';
import unit from './vi/unit.json';
import list from './vi/list.json';
import inbox from './vi/inbox.json';
import console from './vi/console.json';
import palette from './vi/palette.json';
import addProject from './vi/addProject.json';
import subagent from './vi/subagent.json';
import inspector from './vi/inspector.json';
import screens from './vi/screens.json';
import app from './vi/app.json';
import cards from './vi/cards.json';
import errors from './vi/errors.json';
import notify from './vi/notify.json';
import labels from './vi/labels.json';
import deck from './vi/deck.json';
import cardText from './vi/cardText.json';
import tauri from './vi/tauri.json';
import config from './vi/config.json';
import menu from './vi/menu.json';
import session from './vi/session.json';
import done from './vi/done.json';
import stream from './vi/stream.json';
import model from './vi/model.json';
import attach from './vi/attach.json';
import tasks from './vi/tasks.json';
import update from './vi/update.json';

/** namespace → its `vi` strings (the key set every language must carry, engine/test/i18n.test.ts). */
export const VI_NS = { accounts, common, settings, topbar, wizard, format, roles, unit, list, inbox, console, palette, addProject, subagent, inspector, screens, app, cards, errors, notify, labels, deck, cardText, tauri, config, menu, session, done, stream, model, attach, tasks, update } as const;
/** flat `<ns>.<path>` → text; importing this module makes `vi` usable. */
export const VI = addCatalog('vi', VI_NS);
