import { useSuspenseQuery } from "@tanstack/react-query";
import React, { useMemo, useState } from "react";
import { formatBytes, StatusDot } from "../common";
import { cn } from "../lib/cn";
import { agentOsSource } from "../lib/source";
import type {
	AgentOsSystemInfo,
	SystemLimitCategory,
	SystemLimitInfo,
} from "../lib/types";
import { Badge } from "../ui/badge";
import { ScrollArea } from "../ui/scroll-area";

type Filter = "all" | SystemLimitCategory;

const FILTERS: readonly { value: Filter; label: string }[] = [
	{ value: "all", label: "All" },
	{ value: "resource", label: "Resources" },
	{ value: "queue", label: "Queues" },
	{ value: "memory", label: "Memory" },
	{ value: "cpu", label: "CPU" },
	{ value: "unmeasured", label: "Not gauged" },
];

function formatValue(value: number | null, unit: string): string {
	if (value == null) return "—";
	if (unit === "bytes") return formatBytes(value);
	if (unit === "MiB") return `${value.toLocaleString()} MiB`;
	if (unit === "ms") return `${value.toLocaleString()} ms`;
	if (unit === "CPUs") return `${value.toLocaleString()} vCPU`;
	return value.toLocaleString();
}

function fillColor(percent: number | null): string {
	if (percent == null) return "bg-muted-foreground/30";
	if (percent >= 90) return "bg-red-500";
	if (percent >= 70) return "bg-amber-500";
	return "bg-green-500";
}

function dotColor(
	percent: number | null,
): "green" | "amber" | "red" | "muted" {
	if (percent == null) return "muted";
	if (percent >= 90) return "red";
	if (percent >= 70) return "amber";
	return "green";
}

function LimitRow({ limit }: { limit: SystemLimitInfo }) {
	const percent = limit.fillPercent;
	const clamped = Math.min(100, Math.max(0, percent ?? 0));
	return (
		<tr className="border-b border-foreground/[0.06] align-top hover:bg-muted/50">
			<td className="px-3 py-2.5">
				<div className="flex items-center gap-2">
					<span className="font-mono text-xs">{limit.name}</span>
					<Badge
						variant="secondary"
						className="px-2 py-0 text-[10px] font-medium"
					>
						{limit.category === "unmeasured"
							? "not gauged"
							: limit.category}
					</Badge>
				</div>
				<div className="mt-1 max-w-xl text-xs text-muted-foreground">
					{limit.description}
				</div>
				<div className="mt-1 font-mono text-[10px] text-muted-foreground/60">
					{limit.configPath}
				</div>
			</td>
			<td className="min-w-56 px-3 py-2.5">
				{limit.used == null ? (
					<div className="text-xs text-muted-foreground">
						{formatValue(limit.capacity, limit.unit)} limit · no live gauge
					</div>
				) : (
					<>
						<div className="flex items-center justify-between gap-3 text-xs">
							<span className="font-mono">
								{formatValue(limit.used, limit.unit)} /{" "}
								{formatValue(limit.capacity, limit.unit)}
							</span>
							<span className="inline-flex items-center gap-1.5 font-medium">
								<StatusDot color={dotColor(percent)} />
								{percent == null ? "—" : `${percent}%`}
							</span>
						</div>
						<div className="mt-2 h-1.5 overflow-hidden rounded-full bg-muted">
							<div
								className={cn("h-full rounded-full", fillColor(percent))}
								style={{ width: `${clamped}%` }}
							/>
						</div>
					</>
				)}
			</td>
			<td className="whitespace-nowrap px-3 py-2.5 font-mono text-xs text-muted-foreground">
				{formatValue(limit.highWater, limit.unit)}
			</td>
			<td className="whitespace-nowrap px-3 py-2.5">
				<span className="inline-flex items-center gap-1.5 text-xs">
					<StatusDot
						color={limit.source === "configured" ? "amber" : "muted"}
					/>
					{limit.source}
				</span>
			</td>
		</tr>
	);
}

export function LimitsTab({ systemInfo }: { systemInfo: AgentOsSystemInfo }) {
	const [filter, setFilter] = useState<Filter>("all");
	const limits = useMemo(
		() =>
			systemInfo.limits
				.filter((limit) => filter === "all" || limit.category === filter)
				.sort(
					(left, right) =>
						(right.fillPercent ?? -1) - (left.fillPercent ?? -1) ||
						left.name.localeCompare(right.name),
				),
		[filter, systemInfo.limits],
	);

	return (
		<div className="flex h-full flex-col">
			<div className="flex gap-1 border-b px-3 py-2">
				{FILTERS.map((item) => (
					<button
						key={item.value}
						type="button"
						onClick={() => setFilter(item.value)}
						className={cn(
							"rounded px-2.5 py-1 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground",
							filter === item.value && "bg-muted text-foreground",
						)}
					>
						{item.label}
					</button>
				))}
			</div>
			<ScrollArea className="min-h-0 flex-1">
				<table className="w-full text-sm">
					<thead className="text-[11px] uppercase tracking-wide text-muted-foreground">
						<tr className="border-b">
							<th className="px-3 py-2 text-left font-medium">Limit</th>
							<th className="px-3 py-2 text-left font-medium">Usage / limit</th>
							<th className="px-3 py-2 text-left font-medium">High water</th>
							<th className="px-3 py-2 text-left font-medium">Source</th>
						</tr>
					</thead>
					<tbody>
						{limits.map((limit) => (
							<LimitRow key={limit.configPath} limit={limit} />
						))}
					</tbody>
				</table>
			</ScrollArea>
		</div>
	);
}

export function LimitsTabConnected({ actorId }: { actorId: string }) {
	const { data } = useSuspenseQuery(
		agentOsSource.systemInfoQueryOptions(actorId),
	);
	return <LimitsTab systemInfo={data} />;
}
