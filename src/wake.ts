// Keeping the server awake. An instance sleeps after five minutes without a request, and Pi Durable's timed work
// (reminders, jobs, runs waiting on a retry) only moves while one is up, so a scheduled function requests /api/wake
// more often than that. The request also opens the storage if it isn't, which resumes whatever was waiting, and
// brings the AI Gateway's credentials for model calls made outside a request.

export type WakeResult = { ok: boolean; status: number; ms: number };

/** Requests `/api/wake` on `site` once. Never throws: a failed wake is logged by the caller and tried at the next tick. */
export async function wake(site: string, request: typeof fetch = fetch): Promise<WakeResult> {
	const started = Date.now();
	try {
		const response = await request(new URL("/api/wake", site), { headers: { "user-agent": "dreamwalker-wake" } });
		await response.body?.cancel();
		return { ok: response.ok, status: response.status, ms: Date.now() - started };
	} catch {
		return { ok: false, status: 0, ms: Date.now() - started };
	}
}
