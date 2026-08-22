import pluginVue from 'eslint-plugin-vue'
import vueTsEslintConfig from '@vue/eslint-config-typescript'
import skipFormatting from '@vue/eslint-config-prettier/skip-formatting'

export default [
  { files: ['**/*.{ts,mts,tsx,vue}'] },
  { ignores: ['dist/**', 'node_modules/**'] },
  ...pluginVue.configs['flat/essential'],
  ...vueTsEslintConfig(),
  skipFormatting,
  { rules: { 'vue/multi-word-component-names': 'off', '@typescript-eslint/no-explicit-any': 'off' } }
]
