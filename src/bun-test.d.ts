declare module "bun:test" {
	export function describe(name: string, fn: () => void): void;
	export function test(name: string, fn: () => void): void;
	interface Matchers {
		toBe(expected: unknown): void;
		toEqual(expected: unknown): void;
		toContain(item: unknown): void;
		toBeLessThan(n: number): void;
		toBeNull(): void;
	}
	export function expect(actual: unknown): Matchers & { not: Matchers };
}
