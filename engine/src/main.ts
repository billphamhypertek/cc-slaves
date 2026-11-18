#!/usr/bin/env bun
// cc-slaves engine entry (spec §7.1): the real Keychain, login shell, `claude` and network. See boot.ts.
import { runEngine } from './boot.ts';

// v2.5 §5.3 the graph module runs only here: the e2e / smoke entries call runEngine() without it (Z5: never the real tool)
void runEngine({ graphModule: true });
