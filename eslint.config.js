import security from "eslint-plugin-security";
export default [
  {
    files: ["src/**/*.js"],
    plugins: { security },
    rules: {
      "no-eval": "error",
      "no-new-func": "error",
      "no-implied-eval": "error",
      "no-throw-literal": "error",
      "security/detect-child-process": "error",
      "security/detect-eval-with-expression": "error",
      "security/detect-unsafe-regex": "error",
      "security/detect-non-literal-regexp": "error",
    },
  },
];
