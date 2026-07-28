import { createClient } from "rivetkit/client";
import {
	provisionAppNamespace,
	resolveDefaultRivetConnection,
} from "./control-plane.js";
import { AgentOSAppsError } from "./errors.js";
import { appRunnerPool } from "./runtime.js";
import { prepareSource } from "./source.js";
import type {
	DeployAppInput,
	Deployment,
	PreparedDeployAppInput,
} from "./types.js";

interface DeploymentHandle {
	deploy(
		input: PreparedDeployAppInput,
	): Promise<Deployment & { appActorId: string; usesRivetKit: boolean }>;
}

export interface DeployAppOptions {
	/** An ordinary RivetKit client. The default client is created lazily. */
	client?: {
		agentOSAppsApp: {
			getOrCreate(key: string | string[]): DeploymentHandle;
		};
	};
}

let defaultClient: NonNullable<DeployAppOptions["client"]> | undefined;
const HOST_REGISTRY_READY_TIMEOUT_MS = 15_000;
const HOST_REGISTRY_RETRY_DELAY_MS = 50;
const MAX_PLATFORM_ERROR_CHAIN = 4;
const MAX_PLATFORM_ERROR_TEXT = 1_024;
const REPAIRABLE_APP_DIAGNOSTIC_CODES = new Set([
	"agentos_apps_app_id_mismatch",
	"agentos_apps_build_artifact_size_limit",
	"agentos_apps_build_artifact_truncated",
	"agentos_apps_build_failed",
	"agentos_apps_dependency_limit",
	"agentos_apps_duplicate_file_path",
	"agentos_apps_entrypoint_not_found",
	"agentos_apps_file_count_limit",
	"agentos_apps_install_failed",
	"agentos_apps_invalid_config",
	"agentos_apps_invalid_file",
	"agentos_apps_invalid_files",
	"agentos_apps_invalid_package_json",
	"agentos_apps_invalid_region",
	"agentos_apps_invalid_regions",
	"agentos_apps_invalid_rivetkit_dependency",
	"agentos_apps_invalid_scaling",
	"agentos_apps_invalid_warm_timeout",
	"agentos_apps_namespace_changed",
	"agentos_apps_native_addon_unsupported",
	"agentos_apps_pack_failed",
	"agentos_apps_source_limit",
]);

function getDefaultClient(): NonNullable<DeployAppOptions["client"]> {
	defaultClient ??= createClient() as unknown as NonNullable<
		DeployAppOptions["client"]
	>;
	return defaultClient;
}

export async function deployApp(
	input: DeployAppInput,
	options: DeployAppOptions = {},
): Promise<Deployment> {
	try {
		const files = await prepareSource(input);
		const connection = resolveDefaultRivetConnection();
		const runtime = input.createNamespace
			? await provisionAppNamespace(input.appId, connection)
			: {
					endpoint: connection.endpoint,
					namespace: connection.namespace,
					pool: appRunnerPool(input.appId),
				};
		const client = options.client ?? getDefaultClient();
		const app = client.agentOSAppsApp.getOrCreate([input.appId]);
		const result = await deployWhenHostRegistryIsReady(app, {
			appId: input.appId,
			files,
			warmTimeoutMs: input.warmTimeoutMs,
			regions: input.regions,
			scaling: input.scaling,
			namespace: runtime.namespace,
			runtime: {
				endpoint: runtime.endpoint,
				pool: runtime.pool,
			},
		});
		return {
			appId: input.appId,
			release: result.release,
			namespace: result.namespace,
			pool: runtime.pool,
			regions: result.regions,
		};
	} catch (error) {
		if (isAppDiagnostic(error)) throw error;
		throw platformDeployError(error);
	}
}

function isAppDiagnostic(error: unknown): boolean {
	if (error instanceof AgentOSAppsError) return !error.serverFault;
	const code = getErrorCode(error);
	return code !== undefined && REPAIRABLE_APP_DIAGNOSTIC_CODES.has(code);
}

interface PlatformErrorDetail {
	name?: string;
	code?: string;
	message?: string;
	status?: number;
}

function platformDeployError(error: unknown): AgentOSAppsError {
	const chain: PlatformErrorDetail[] = [];
	const visited = new Set<unknown>();
	let current: unknown = error;
	while (
		current !== undefined &&
		current !== null &&
		chain.length < MAX_PLATFORM_ERROR_CHAIN &&
		!visited.has(current)
	) {
		visited.add(current);
		const detail = platformErrorDetail(current);
		if (Object.keys(detail).length > 0) chain.push(detail);
		current =
			typeof current === "object" && "cause" in current
				? current.cause
				: undefined;
	}
	return new AgentOSAppsError(
		"agentos_apps_server_fault",
		"agentOS Apps deployment failed in the host platform; retry or inspect host logs instead of repairing application source",
		{
			serverFault: true,
			chain:
				chain.length > 0
					? chain
					: [{ message: "The platform returned no error details." }],
		},
		{ serverFault: true, cause: error },
	);
}

function platformErrorDetail(error: unknown): PlatformErrorDetail {
	if (typeof error !== "object" || error === null) {
		return { message: redactPlatformErrorText(String(error)) };
	}
	const detail: PlatformErrorDetail = {};
	if (
		"name" in error &&
		typeof error.name === "string" &&
		error.name !== "Error"
	) {
		detail.name = redactPlatformErrorText(error.name);
	}
	const code = getErrorCode(error);
	if (code) detail.code = redactPlatformErrorText(code);
	if ("message" in error && typeof error.message === "string") {
		detail.message = redactPlatformErrorText(error.message);
	}
	const status =
		"status" in error && typeof error.status === "number"
			? error.status
			: "statusCode" in error && typeof error.statusCode === "number"
				? error.statusCode
				: undefined;
	if (status !== undefined) detail.status = status;
	return detail;
}

function redactPlatformErrorText(value: string): string {
	return value
		.replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]")
		.replace(
			/\b(authorization|api[-_ ]?key|password|secret|token)\b(\s*[:=]\s*|\s+)([^\s,;]+)/gi,
			"$1$2[redacted]",
		)
		.replace(
			/\b(https?:\/\/)([^/\s:@]+):([^/\s@]+)@([^/\s]+)(\/[^\s]*)?/gi,
			"$1[redacted]@[redacted-host]/[redacted]",
		)
		.replace(
			/\b(https?:\/\/[^/\s?#]+)\/[^\s?#]+(?:[?#][^\s]*)?/gi,
			"$1/[redacted]",
		)
		.slice(0, MAX_PLATFORM_ERROR_TEXT);
}

async function deployWhenHostRegistryIsReady(
	app: DeploymentHandle,
	input: PreparedDeployAppInput,
): Promise<Deployment & { appActorId: string; usesRivetKit: boolean }> {
	const deadline = Date.now() + HOST_REGISTRY_READY_TIMEOUT_MS;
	let lastError: unknown;

	do {
		try {
			return await app.deploy(input);
		} catch (error) {
			if (getErrorCode(error) !== "no_runner_config_configured") throw error;
			lastError = error;
			await new Promise((resolve) =>
				setTimeout(resolve, HOST_REGISTRY_RETRY_DELAY_MS),
			);
		}
	} while (Date.now() < deadline);

	throw new AgentOSAppsError(
		"host_registry_not_ready",
		`AgentOS Apps could not reach the host actor runner within ${HOST_REGISTRY_READY_TIMEOUT_MS}ms. Call registry.start() before deployApp().`,
		{
			timeoutMs: HOST_REGISTRY_READY_TIMEOUT_MS,
			lastCode: getErrorCode(lastError),
		},
		{ serverFault: true, cause: lastError },
	);
}

function getErrorCode(error: unknown): string | undefined {
	if (typeof error !== "object" || error === null || !("code" in error)) {
		return undefined;
	}
	return typeof error.code === "string" ? error.code : undefined;
}

/** @internal Test-only reset for verifying lazy client creation. */
export function resetDefaultAppsClientForTest(): void {
	defaultClient = undefined;
}
