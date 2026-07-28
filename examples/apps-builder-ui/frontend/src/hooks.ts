import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import * as api from "./api";

export function useApps() {
	return useQuery({
		queryKey: ["apps"],
		queryFn: api.listApps,
		refetchInterval: 10_000,
	});
}

export function useApp(id: string) {
	return useQuery({ queryKey: ["apps", id], queryFn: () => api.getApp(id) });
}

export function useCreateApp() {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: api.createApp,
		onSuccess: () => queryClient.invalidateQueries({ queryKey: ["apps"] }),
	});
}

export function useInspectorInfo(id: string) {
	return useQuery({
		queryKey: ["apps", id, "inspector"],
		queryFn: () => api.getInspectorInfo(id),
	});
}

export function useSystemPrompt() {
	return useQuery({
		queryKey: ["system-prompt"],
		queryFn: api.getSystemPrompt,
		staleTime: Number.POSITIVE_INFINITY,
	});
}
