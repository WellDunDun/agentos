import type { ZodType } from "zod";

/** Maximum length for binding and binding group descriptions (characters). */
export const MAX_BINDING_DESCRIPTION_LENGTH = 200;

/**
 * A single binding that executes on the host.
 * Mirrors the shape of AI SDK's tool() but with host-execution semantics.
 */
export interface Binding<INPUT = any, OUTPUT = any> {
	/** Description shown to the agent in --help and prompt docs. Max 200 characters. */
	description: string;
	/** Zod schema for the input. Drives CLI flag generation and validation. */
	inputSchema: ZodType<INPUT>;
	/** Runs on the host when the agent invokes the binding. */
	execute: (input: INPUT) => Promise<OUTPUT> | OUTPUT;
	/** Examples included in auto-generated prompt docs. */
	examples?: BindingExample<INPUT>[];
	/** Timeout in ms. Default: 30000. */
	timeout?: number;
}

export interface BindingExample<INPUT = any> {
	/** Human description of what this example does. */
	description: string;
	/** The input args for the example. */
	input: INPUT;
}

/**
 * A named group of bindings. Becomes a CLI binary: agentos-{name}.
 */
export interface BindingGroup {
	/** Binding group name. Must be lowercase alphanumeric + hyphens. Becomes the CLI suffix: agentos-{name}. */
	name: string;
	/** Description shown in `agentos list-bindings` and prompt docs. */
	description: string;
	/** The bindings in this binding group. Keys become subcommands. */
	bindings: Record<string, Binding>;
}

/** Helper to create a Binding with type inference. */
export function binding<INPUT, OUTPUT>(
	def: Binding<INPUT, OUTPUT>,
): Binding<INPUT, OUTPUT> {
	return def;
}

/** Helper to create a BindingGroup. */
export function bindingGroup(def: BindingGroup): BindingGroup {
	return def;
}

/**
 * Validate all description lengths in the given bindings.
 * Throws if any binding group or binding description exceeds MAX_BINDING_DESCRIPTION_LENGTH.
 */
export function validateBindings(bindings: BindingGroup[]): void {
	for (const tk of bindings) {
		if (tk.description.length > MAX_BINDING_DESCRIPTION_LENGTH) {
			throw new Error(
				`BindingGroup "${tk.name}" description is ${tk.description.length} characters, max is ${MAX_BINDING_DESCRIPTION_LENGTH}`,
			);
		}
		for (const [bindingName, binding] of Object.entries(tk.bindings)) {
			if (binding.description.length > MAX_BINDING_DESCRIPTION_LENGTH) {
				throw new Error(
					`Binding "${tk.name}/${bindingName}" description is ${binding.description.length} characters, max is ${MAX_BINDING_DESCRIPTION_LENGTH}`,
				);
			}
		}
	}
}
