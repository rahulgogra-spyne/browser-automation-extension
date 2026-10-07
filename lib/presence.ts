// Shows, outside the panel, which tab the extension is using and whether it needs you:
// - the tab goes into a Chrome tab group whose colour and label ("VIN Flow · <state>") follow the
//   run's state, so it stands out in the tab strip even when the panel is closed or you're in another tab;
// - the toolbar icon gets a matching badge.

export type Presence = 'working' | 'handoff' | 'done' | 'error' | 'stopped';

const LOOK: Record<Presence, { title: string; color: `${chrome.tabGroups.Color}`; badge: string; badgeColor: string }> = {
  working: { title: 'VIN Flow · working', color: 'blue', badge: '…', badgeColor: '#2563eb' },
  handoff: { title: 'VIN Flow · your turn', color: 'yellow', badge: '!', badgeColor: '#d97706' },
  done: { title: 'VIN Flow · done', color: 'green', badge: '✓', badgeColor: '#16a34a' },
  error: { title: 'VIN Flow · error', color: 'red', badge: '!', badgeColor: '#dc2626' },
  stopped: { title: 'VIN Flow · stopped', color: 'grey', badge: '', badgeColor: '#6b7280' },
};

/** How long a finished run keeps its group before the tab goes back to normal. */
const LINGER_MS = 20_000;

let groupId: number | undefined;
let ungroupTimer: ReturnType<typeof setTimeout> | undefined;

/** Put `tabId` in the VIN Flow group (creating it if needed) and show `state`. Never throws. */
export async function mark(tabId: number, state: Presence): Promise<void> {
  clearTimeout(ungroupTimer);
  const look = LOOK[state];
  try {
    const tab = await chrome.tabs.get(tabId);
    const existing = groupId != null ? await chrome.tabGroups.get(groupId).catch(() => undefined) : undefined;
    if (!existing || existing.windowId !== tab.windowId) groupId = undefined;
    // Never pull a tab out of a group the user made; the badge and the panel still show the state.
    const theirs = tab.groupId !== -1 && tab.groupId !== groupId;
    if (!theirs && (tab.groupId !== groupId || groupId == null)) {
      groupId = await chrome.tabs.group(groupId == null ? { tabIds: tabId, createProperties: { windowId: tab.windowId } } : { tabIds: tabId, groupId });
    }
    if (!theirs && groupId != null) await chrome.tabGroups.update(groupId, { title: look.title, color: look.color, collapsed: false });
  } catch {
    // Tab closed, or groups unavailable (a popup window): the panel still shows the state.
  }
  void chrome.action.setBadgeText({ text: look.badge });
  void chrome.action.setBadgeBackgroundColor({ color: look.badgeColor });
  if (state === 'done' || state === 'stopped' || state === 'error') {
    ungroupTimer = setTimeout(() => void release(), LINGER_MS);
  }
}

/** Ungroup the tabs and clear the badge. */
export async function release(): Promise<void> {
  clearTimeout(ungroupTimer);
  void chrome.action.setBadgeText({ text: '' });
  if (groupId == null) return;
  const tabs = await chrome.tabs.query({ groupId }).catch(() => []);
  const ids = tabs.map((t) => t.id!).filter(Boolean);
  if (ids.length) await chrome.tabs.ungroup(ids as [number, ...number[]]).catch(() => {});
  groupId = undefined;
}
