import {
	createRootRoute,
	createRoute,
	createRouter,
	Outlet,
} from "@tanstack/react-router";
import { Landing } from "./routes/Landing";
import { Editor } from "./routes/Editor";
import { Toaster } from "./components/Toaster";

const rootRoute = createRootRoute({
	component: () => (
		<>
			<Outlet />
			<Toaster />
		</>
	),
});

const landingRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: "/",
	component: Landing,
});

const editorRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: "/app/$appId",
	component: Editor,
});

const routeTree = rootRoute.addChildren([landingRoute, editorRoute]);

export const router = createRouter({ routeTree });

declare module "@tanstack/react-router" {
	interface Register {
		router: typeof router;
	}
}
