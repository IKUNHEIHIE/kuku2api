import { createHash } from 'node:crypto';
import { flattenTasks } from './gateway.mjs';

export function validDesktopContext(context) {
  return context?.source === 'installed_native_client' && /^BDIMXV2-[A-Za-z0-9_.-]{10,512}$/.test(context.devuid ?? '')
    && /^[1-9][0-9]{0,31}$/.test(context.device_id ?? '') && context.clienttype === '401'
    && /^[0-9.]{1,32}$/.test(context.version ?? '') && /^[A-Za-z0-9_-]{1,160}$/.test(context.channel ?? '')
    && ['0', '1'].includes(context.win64);
}

// One attempt per verified user, persisted before any reward-related request. Startup
// never traverses old accounts. Duplicate local rows share the same initialization queue.
export function createDesktopLogin({ database, pool }) {
  const unavailable = () => ({ ok: false, status: 'unavailable', code: 'desktop_context_unavailable',
    message: '未配置本机官方电脑端设备信息，账号已保留；请先导入本机设备信息后手动补跑', balance_before: null, balance_after: null, balance_delta: null });
  async function balance(client) {
    try {
      const d = await client.vipRemain();
      const asset = d.list?.find((x) => Number(x.assetType) === 1);
      if (!asset || asset.totalPoint == null || asset.totalPoint === '') return null;
      const n = Number(asset.totalPoint);
      return Number.isFinite(n) ? n : null;
    } catch { return null; }
  }
  async function execute(account, { retry = false } = {}) {
    if (!database || !account.upstream_user_id) return unavailable();
    const key = `desktop_login:${createHash('sha256').update(account.upstream_user_id).digest('hex')}`;
    const store = database.store(key);
    const previous = store.load();
    if (previous.status === 'completed') return { ...previous.result, replayed: true };
    if (['running', 'verification_pending'].includes(previous.status)) {
      // Lost response/crash: read-only verification, never repeat a potentially paid report.
      const after = await balance(account.client);
      const before = previous.result?.balance_before ?? null;
      const delta = before !== null && after !== null ? Math.round((after - before) * 1e8) / 1e8 : null;
      const result = { ...previous.result, ok: false, status: 'verification_pending', code: 'desktop_verification_pending',
        balance_after: after, balance_delta: delta, replayed: true,
        message: '前次上报结果未能确认，已刷新余额；为避免重复发奖请求，本次未重新上报' };
      store.save({ status: 'verification_pending', result });
      return result;
    }
    if (previous.status === 'failed' && !retry) return { ...previous.result, replayed: true };
    const context = database.store('desktop_context').load();
    if (!validDesktopContext(context)) return unavailable();
    const result = previous.status === 'failed' ? { ...previous.result, ok: false, status: 'running',
      reported: [...previous.result.reported], claimed: [...previous.result.claimed], notes: [...previous.result.notes] }
      : { ok: false, status: 'running', attempted_at: new Date().toISOString(), is_new: null,
      reported: [], task_status: null, claimed_points: 0, claimed: [], balance_before: await balance(account.client),
      balance_after: null, balance_delta: null, notes: [] };
    store.save({ status: 'running', result });
    let phase = 'login_report';
    try {
      if (!result.reported.includes('USER_REPORT')) {
        const report = await account.client.desktopLoginReport(context);
        if (report.upstream_user_id !== account.upstream_user_id) throw Object.assign(new Error('identity mismatch'), { code: 'desktop_identity_mismatch' });
        result.is_new = report.is_new;
        result.reported.push('USER_REPORT');
        store.save({ status: 'running', result });
      }
      phase = 'self_download';
      if (!result.reported.includes('SELF_DOWNLOAD')) {
        const completed = await account.client.claimTask({ task_type: 'SELF_DOWNLOAD', device_id: context.device_id, auto_claim: true });
        result.task_status = completed?.complete_status ?? null;
        if (completed?.complete_status !== 'SUCCESS') throw Object.assign(new Error('task report refused'), { code: 'desktop_task_refused' });
        result.reported.push('SELF_DOWNLOAD');
        store.save({ status: 'running', result });
      }
      // If auto_claim left a ready SELF_DOWNLOAD reward, claim only that task, never
      // invitations, daily tasks or any fabricated task key.
      phase = 'reward_read';
      let tasks;
      try { tasks = flattenTasks(await account.client.freePointHome()); }
      catch { result.notes.push('电脑端任务已上报，但奖励列表暂时无法读取；请刷新任务列表'); tasks = []; }
      for (const task of tasks.filter((t) => t.task_type === 'SELF_DOWNLOAD' && Number(t.claimable_point) > 0 && !result.claimed.some((c) => c.task_key === t.task_key))) {
        phase = 'reward_claim';
        const reward = await account.client.claimReward({ activity_key: task.activity_key, period_id: task.period_id, task_key: task.task_key });
        if (reward?.claim_status !== 'SUCCESS') throw Object.assign(new Error('reward refused'), { code: 'desktop_reward_refused' });
        const points = Number(reward.claimed_point);
        if (!Number.isFinite(points) || points < 0) throw Object.assign(new Error('invalid reward'), { code: 'desktop_reward_invalid' });
        result.claimed.push({ task_key: task.task_key, claimed_point: points });
        result.claimed_points += points;
        store.save({ status: 'running', result });
      }
      result.ok = true;
      delete result.code;
      delete result.phase;
      result.balance_after = await balance(account.client);
      result.balance_delta = result.balance_before !== null && result.balance_after !== null
        ? Math.round((result.balance_after - result.balance_before) * 1e8) / 1e8 : null;
      result.status = result.balance_delta > 0 ? 'credited' : result.balance_delta === null ? 'balance_unknown' : 'no_credit';
      result.message = result.status === 'credited' ? '已观察到积分余额增加，实际额度以上游为准'
        : result.status === 'balance_unknown' ? '已完成电脑端上报，但暂时无法核实到账余额'
        : '电脑端上报已完成，当前未观察到余额增加；可能无资格、已领取或上游延迟';
      result.notes.push('balance_delta 是两次余额的观测差额；并发使用、其他赠送或扣费也可能影响，不等同于单项奖励金额');
      store.save({ status: 'completed', result });
      return result;
    } catch (error) {
      // Explicit upstream refusal can be retried manually. Network/HTTP uncertainty
      // after a write is sticky so browser retries cannot repeat reward requests.
      const definitive = error?.network !== true && ((error?.name === 'UpstreamError' && error?.code != null)
        || ['desktop_identity_mismatch', 'desktop_task_refused', 'desktop_reward_refused'].includes(error?.code));
      result.status = definitive ? 'failed' : 'verification_pending';
      result.code = typeof error?.code === 'string' || typeof error?.code === 'number' ? error.code : 'desktop_report_uncertain';
      result.phase = phase;
      result.message = definitive ? '上游未接受电脑端初始化，请查看阶段及错误码；账号已保留' : '电脑端初始化结果暂时无法确认，账号已保留，请刷新余额核对';
      result.balance_after = await balance(account.client);
      result.balance_delta = result.balance_before !== null && result.balance_after !== null
        ? Math.round((result.balance_after - result.balance_before) * 1e8) / 1e8 : null;
      store.save({ status: definitive ? 'failed' : 'verification_pending', result });
      return result;
    }
  }
  function run(account, options) {
    const identity = account.upstream_user_id ?? account.id;
    return pool.serialize(`desktop:${identity}`, () => pool.serialize(`claim:${account.id}`, () => execute(account, options)));
  }
  function state(account) {
    if (!database || !account.upstream_user_id) return { configured: false, initialization: null };
    const key = `desktop_login:${createHash('sha256').update(account.upstream_user_id).digest('hex')}`;
    return { configured: validDesktopContext(database.store('desktop_context').load()), initialization: database.store(key).load().result ?? null };
  }
  return { run, state };
}
