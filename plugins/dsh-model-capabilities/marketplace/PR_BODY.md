## Summary

Add `WJZ-P/dsh-model-capabilities` to the **Model & Provider Tools** category.
The plugin contributes an input-modality selector to the existing DeepSeek
Harness model editor and stores the selection in the standard model `input`
field.

## Plugin contract

- Repository: https://github.com/WJZ-P/dsh-model-capabilities
- npm package: `dsh-model-capability`
- Project icon: https://raw.githubusercontent.com/WJZ-P/dsh-model-capabilities/main/assets/markdown/model-capability.svg
- Catalog category: `model`
- Installable `dsh.bundle.patch`: `./cordis.patch.yml`
- Browser platform: `web`
- UI extension slot: `settings.models.model.fields`
- Official `@deepseek-ai/*` packages: peer dependencies

## Verification

- [ ] Repository is at least one day old and has at least ten commits.
- [ ] Repository has the `dsh-plugin` topic.
- [ ] Plugin CI is green.
- [ ] Catalog and generated README checks pass in the marketplace repository.
- [ ] Optional screenshots use GitHub-hosted HTTPS URLs.

## Marketplace commands

```sh
npm ci
node scripts/generate-readme.mjs
```
