import { describe, expect, test } from "vitest";
import { z } from "zod";
import {
	BindingSchemaConversionError,
	zodToJsonSchema,
} from "../src/bindings-zod.js";
import {
	MAX_BINDING_DESCRIPTION_LENGTH,
	binding,
	bindingGroup,
	validateBindings,
} from "../src/index.js";

describe("host binding description limits", () => {
	test("accepts bindingGroup and binding descriptions at the exported limit", () => {
		const description = "a".repeat(MAX_BINDING_DESCRIPTION_LENGTH);

		expect(() =>
			validateBindings([
				bindingGroup({
					name: "browser",
					description,
					bindings: {
						screenshot: binding({
							description,
							inputSchema: z.object({ url: z.string() }),
							execute: () => ({ ok: true }),
						}),
					},
				}),
			]),
		).not.toThrow();
	});

	test("rejects binding descriptions longer than the exported limit", () => {
		expect(() =>
			validateBindings([
				bindingGroup({
					name: "browser",
					description: "a".repeat(MAX_BINDING_DESCRIPTION_LENGTH + 1),
					bindings: {
						screenshot: binding({
							description: "Take a screenshot",
							inputSchema: z.object({ url: z.string() }),
							execute: () => ({ ok: true }),
						}),
					},
				}),
			]),
		).toThrow(
			`BindingGroup "browser" description is ${MAX_BINDING_DESCRIPTION_LENGTH + 1} characters, max is ${MAX_BINDING_DESCRIPTION_LENGTH}`,
		);
	});

	test("rejects binding descriptions longer than the exported limit", () => {
		expect(() =>
			validateBindings([
				bindingGroup({
					name: "browser",
					description: "Browser automation",
					bindings: {
						screenshot: binding({
							description: "a".repeat(MAX_BINDING_DESCRIPTION_LENGTH + 1),
							inputSchema: z.object({ url: z.string() }),
							execute: () => ({ ok: true }),
						}),
					},
				}),
			]),
		).toThrow(
			`Binding "browser/screenshot" description is ${MAX_BINDING_DESCRIPTION_LENGTH + 1} characters, max is ${MAX_BINDING_DESCRIPTION_LENGTH}`,
		);
	});

	test("fails loudly when a host binding input schema uses an unsupported discriminated union", () => {
		const inspectBinding = binding({
			description: "Inspect a variant payload",
			inputSchema: z.object({
				payload: z.discriminatedUnion("kind", [
					z.object({ kind: z.literal("text"), value: z.string() }),
					z.object({ kind: z.literal("code"), status: z.number() }),
				]),
			}),
			execute: () => ({ ok: true }),
		});

		try {
			zodToJsonSchema(inspectBinding.inputSchema);
			throw new Error("Expected unsupported host binding schema to fail");
		} catch (error) {
			expect(error).toBeInstanceOf(BindingSchemaConversionError);
			expect(error).toMatchObject({
				path: "$.payload",
				zodType: "discriminatedUnion",
			});
		}
	});
});
