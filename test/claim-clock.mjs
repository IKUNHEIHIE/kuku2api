// Virtual time for synthetic claims: keep the production 15-second rule without wall-clock waits.
export function claimClock() {
  let now = 0;
  return { claimNow: () => now, claimWait: async ms => { now += ms; } };
}
