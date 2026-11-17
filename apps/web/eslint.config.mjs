import js from "@eslint/js";
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";

export default tseslint.config(
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["src/app/**/*.{ts,tsx}", "src/shared/**/*.{ts,tsx}", "src/entities/**/*.{ts,tsx}", "src/features/**/*.{ts,tsx}", "src/widgets/**/*.{ts,tsx}"],
    plugins: {
      "react-hooks": reactHooks
    },
    rules: {
      ...reactHooks.configs.recommended.rules
    }
  },
  {
    files: ["src/app/**/*.{ts,tsx}", "src/entities/**/*.{ts,tsx}", "src/features/**/*.{ts,tsx}", "src/widgets/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector: "JSXOpeningElement[name.name='button']",
          message: "禁止在业务层直接写原生 <button>，请使用 @/shared/ui 中的 <Button> 或 <IconButton>。"
        },
        {
          selector: "JSXOpeningElement[name.name='dialog']",
          message: "禁止在业务层直接写原生 <dialog>，请使用 @/shared/ui 中的 <Dialog>。"
        },
        {
          selector: "JSXOpeningElement[name.name='select']",
          message: "禁止在业务层直接写原生 <select>，请使用 @/shared/ui 中的 <Select>。"
        },
        {
          selector: "ImportDeclaration[source.value=/\\.css$/]",
          message: "禁止在业务模块引入独立 .css 文件，请使用 Tailwind CSS v4 工具类与语义 Token。"
        }
      ]
    }
  }
);
