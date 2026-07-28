// browser_test implementation: drives the LIVE deployed app in a headless
// browser. Locally this launches system Chromium; set BROWSERBASE_CONNECT_URL
// (wss://connect.browserbase.com?apiKey=...) to run the session on Browserbase
// instead — that requires the deployment to be reachable from the internet.
import puppeteer, { type Browser } from "puppeteer-core";

export interface BrowserAction {
	type: "click" | "fill" | "wait_for";
	selector: string;
	text?: string;
}

export interface BrowserTestInput {
	url: string;
	actions?: BrowserAction[];
	expect_texts?: string[];
}

export interface BrowserTestResult {
	ok: boolean;
	consoleErrors: string[];
	checks: { text: string; found: boolean }[];
	actionErrors: string[];
	pageText: string;
}

const CHROMIUM_PATH = process.env.CHROMIUM_PATH ?? "/usr/bin/chromium";

async function launch(): Promise<Browser> {
	const connectUrl = process.env.BROWSERBASE_CONNECT_URL;
	if (connectUrl) {
		return puppeteer.connect({ browserWSEndpoint: connectUrl });
	}
	return puppeteer.launch({
		executablePath: CHROMIUM_PATH,
		args: ["--no-sandbox", "--disable-dev-shm-usage"],
	});
}

export async function browserTest(
	input: BrowserTestInput,
): Promise<BrowserTestResult> {
	const browser = await launch();
	const consoleErrors: string[] = [];
	const actionErrors: string[] = [];
	try {
		const page = await browser.newPage();
		page.on("console", (message) => {
			if (message.type() === "error") {
				consoleErrors.push(message.text().slice(0, 500));
			}
		});
		page.on("pageerror", (error) => {
			consoleErrors.push(String(error).slice(0, 500));
		});
		await page.goto(input.url, { waitUntil: "networkidle2", timeout: 30_000 });

		for (const action of input.actions ?? []) {
			try {
				switch (action.type) {
					case "click":
						await page.click(action.selector);
						break;
					case "fill":
						await page.type(action.selector, action.text ?? "");
						break;
					case "wait_for":
						await page.waitForSelector(action.selector, { timeout: 5_000 });
						break;
				}
				await new Promise((resolve) => setTimeout(resolve, 300));
			} catch (error) {
				actionErrors.push(
					`${action.type} ${action.selector}: ${error instanceof Error ? error.message : String(error)}`,
				);
			}
		}

		// Give client-side JS a beat to settle after the last action.
		await new Promise((resolve) => setTimeout(resolve, 500));
		const pageText = await page.evaluate(
			() => document.body?.innerText ?? "",
		);
		const checks = (input.expect_texts ?? []).map((text) => ({
			text,
			found: pageText.includes(text),
		}));
		return {
			ok:
				consoleErrors.length === 0 &&
				actionErrors.length === 0 &&
				checks.every((check) => check.found),
			consoleErrors,
			checks,
			actionErrors,
			pageText: pageText.slice(0, 4_000),
		};
	} finally {
		await browser.close();
	}
}
