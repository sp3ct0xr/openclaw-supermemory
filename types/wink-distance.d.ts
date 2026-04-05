declare module "wink-distance" {
	const wd: {
		bow: {
			cosine(a: Record<string, number>, b: Record<string, number>): number
		}
		set: {
			jaccard(a: Set<string>, b: Set<string>): number
			tversky(a: Set<string>, b: Set<string>, alpha?: number, beta?: number): number
		}
		string: {
			jaro(a: string, b: string): number
			jaroWinkler(a: string, b: string, boostThreshold?: number, scalingFactor?: number): number
			levenshtein(a: string, b: string): number
			soundex(a: string, b: string): number
		}
	}
	export default wd
}
