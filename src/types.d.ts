declare module "graphql-depth-limit" {
  import { DocumentNode, ValidationRule } from "graphql";
  function depthLimit(maxDepth: number, ignore?: string[]): ValidationRule;
  export default depthLimit;
}
