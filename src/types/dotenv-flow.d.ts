declare module "dotenv-flow" {
  export function config(options?: unknown): unknown;
  const dotenvFlow: { config: typeof config };
  export default dotenvFlow;
}
