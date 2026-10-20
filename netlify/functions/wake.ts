// Every four minutes, inside the server's five-minute idle window, so production stays awake (src/wake.ts). Scheduled
// functions run only for the published production deploy. `URL` is the site's main address.

import { wake } from "../../src/wake.ts";

export default async () => {
	const site = process.env.URL;
	if (site === undefined) return console.error("[wake] URL isn't set");
	const result = await wake(site);
	(result.ok ? console.log : console.error)("[wake]", result);
};

export const config = { schedule: "*/4 * * * *" };
