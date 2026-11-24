import '@fontsource/inter-tight/300.css';
import '@fontsource/inter-tight/400.css';
import '@fontsource/inter-tight/500.css';
import '@fontsource/jetbrains-mono/400.css';
import '@fontsource/jetbrains-mono/500.css';
import '@fontsource/jetbrains-mono/600.css';
import './design/styles.css';

import type { Day, Fact, StoryPlan, Transaction } from '../contracts/index.js';
import daysJson from '../data/days.json';
import factsJson from '../data/facts.json';
import transactionsJson from '../data/transactions.json';
import planJson from '../story/plan.json';
import { registerBespokeChapters } from './chapters/bespoke/index.js';
import { StoryPlayer, installCaptureBridge, type YearAppCaptureBridge } from './player/index.js';

export interface BootstrappedApp {
  player: StoryPlayer;
  bridge: YearAppCaptureBridge;
}

export function bootstrapApp(root: HTMLElement): BootstrappedApp {
  const transactions = transactionsJson as unknown as readonly Transaction[];
  const days = daysJson as unknown as readonly Day[];
  const facts = factsJson as unknown as readonly Fact[];
  const plan = planJson as unknown as StoryPlan;

  const player = new StoryPlayer(root, {
    transactions,
    days,
    facts,
    plan,
  });

  // Register bespoke chapters ("studio", "coffee", "bespoke_0", "bespoke_1", plus fallbacks)
  registerBespokeChapters(player);

  const bridge = installCaptureBridge(player);

  root.dataset.ready = 'true';
  root.dataset.transactions = String(transactions.length);
  root.dataset.chapters = String(plan.chapters.length);
  root.dataset.person = plan.person_name;

  // Auto-start film mode if ?film=1 is in URL
  if (typeof window !== 'undefined') {
    const params = new URLSearchParams(window.location.search);
    if (params.get('film') === '1') {
      bridge.startFilm();
    } else if (params.get('chapter')) {
      bridge.goToChapter(params.get('chapter')!);
    }
  }

  return { player, bridge };
}

const rootEl = typeof document !== 'undefined' ? document.getElementById('app') : null;
if (rootEl) {
  bootstrapApp(rootEl);
}
