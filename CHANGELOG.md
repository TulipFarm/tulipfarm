# Changelog

## [0.13.0](https://github.com/TulipFarm/tulipfarm/compare/v0.12.4...v0.13.0) (2026-08-21)

### Features

* **integrations:** add Google Workspace integration — login, chat tools, and token refresh ([#498](https://github.com/TulipFarm/tulipfarm/issues/498)) ([6b3e182](https://github.com/TulipFarm/tulipfarm/commit/6b3e1827cb77258c2733c29262a9307bc0aaec1f))

### Bug Fixes

* **integrations:** add setup_url to GitHub App manifest ([#536](https://github.com/TulipFarm/tulipfarm/issues/536)) ([12957e0](https://github.com/TulipFarm/tulipfarm/commit/12957e03b24ee80f7199c565813557e1ba409c63))

## [0.12.4](https://github.com/TulipFarm/tulipfarm/compare/v0.12.3...v0.12.4) (2026-08-21)

### Features

* **integrations:** support targeting a GitHub org for App creation ([#534](https://github.com/TulipFarm/tulipfarm/issues/534)) ([d887018](https://github.com/TulipFarm/tulipfarm/commit/d887018e7d521e1308cc834f4cbf7b986628415c))

## [0.12.3](https://github.com/TulipFarm/tulipfarm/compare/v0.12.2...v0.12.3) (2026-08-21)

### Bug Fixes

* **storage:** re-assert bundled bucket secret perms every boot ([#532](https://github.com/TulipFarm/tulipfarm/issues/532)) ([23ee09e](https://github.com/TulipFarm/tulipfarm/commit/23ee09e56c643f0a762a22fd85d0b98b6c712fa3))

## [0.12.2](https://github.com/TulipFarm/tulipfarm/compare/v0.12.1...v0.12.2) (2026-08-20)

### Bug Fixes

* **agent-runtime:** stop a Turn narrating a hand-off it never made ([#510](https://github.com/TulipFarm/tulipfarm/issues/510)) ([036ba30](https://github.com/TulipFarm/tulipfarm/commit/036ba30445065f3c5a5dd024f58cb7ddbb08d8d9)), closes [#419](https://github.com/TulipFarm/tulipfarm/issues/419), references [#405](https://github.com/TulipFarm/tulipfarm/issues/405)
* **agent-runtime:** stop a Turn writing behind its own report ([#522](https://github.com/TulipFarm/tulipfarm/issues/522)) ([de2c686](https://github.com/TulipFarm/tulipfarm/commit/de2c6863e6f5c8fe0c300cf6aca3228acc8f0907)), closes [#429](https://github.com/TulipFarm/tulipfarm/issues/429), references [#419](https://github.com/TulipFarm/tulipfarm/issues/419) [#405](https://github.com/TulipFarm/tulipfarm/issues/405) [#417](https://github.com/TulipFarm/tulipfarm/issues/417) [#451](https://github.com/TulipFarm/tulipfarm/issues/451) [pre-#451](https://github.com/pre-/issues/451)
* **auth:** issue an invite link in one statement ([#511](https://github.com/TulipFarm/tulipfarm/issues/511)) ([9490a23](https://github.com/TulipFarm/tulipfarm/commit/9490a23fe8ace65f144191eb7c3141d69a7c2ecb))
* **authz:** let a granted Owner reach every admin-only action ([#521](https://github.com/TulipFarm/tulipfarm/issues/521)) ([c9bf68a](https://github.com/TulipFarm/tulipfarm/commit/c9bf68a7fe70ba7d4d07a3b9f0d162282790ff5e)), references [#408](https://github.com/TulipFarm/tulipfarm/issues/408)
* **chat:** show an empty state for every mention trigger ([#519](https://github.com/TulipFarm/tulipfarm/issues/519)) ([c0f6da9](https://github.com/TulipFarm/tulipfarm/commit/c0f6da93b7eba02047b6e3a062701c7e38c11aac)), references [#450](https://github.com/TulipFarm/tulipfarm/issues/450)
* **curator:** retire a job whose Run was parked for reconciliation ([#523](https://github.com/TulipFarm/tulipfarm/issues/523)) ([0b10f19](https://github.com/TulipFarm/tulipfarm/commit/0b10f1956ed6d5744972e14a85413447bfd61881))
* **forge:** enforce name and resource checks in forge Tools ([#530](https://github.com/TulipFarm/tulipfarm/issues/530)) ([f4f534b](https://github.com/TulipFarm/tulipfarm/commit/f4f534bf84dd40ff7cf0369720586e63e0f198da)), closes [#463](https://github.com/TulipFarm/tulipfarm/issues/463) [#435](https://github.com/TulipFarm/tulipfarm/issues/435) [#436](https://github.com/TulipFarm/tulipfarm/issues/436), references [#435](https://github.com/TulipFarm/tulipfarm/issues/435) [#463](https://github.com/TulipFarm/tulipfarm/issues/463) [#436](https://github.com/TulipFarm/tulipfarm/issues/436)
* **integration-worker:** gate Slack self-posts and metadata subtypes ([#524](https://github.com/TulipFarm/tulipfarm/issues/524)) ([632048f](https://github.com/TulipFarm/tulipfarm/commit/632048f6707795ed93c9b1099125edd689f16af6)), references [#508](https://github.com/TulipFarm/tulipfarm/issues/508)
* **integrations:** cage caller-supplied Git clone sources ([#515](https://github.com/TulipFarm/tulipfarm/issues/515)) ([45876b6](https://github.com/TulipFarm/tulipfarm/commit/45876b69dbc9293b4f3766df0e468e1f193ef9a2))
* **knowledge:** place and grant a Page authored by create_knowledge_page ([#517](https://github.com/TulipFarm/tulipfarm/issues/517)) ([ad80a77](https://github.com/TulipFarm/tulipfarm/commit/ad80a774feffa0ac49efc2ad1dc42ed6a6f01d37))
* **resources:** make Record mutation and history one transaction ([#513](https://github.com/TulipFarm/tulipfarm/issues/513)) ([36bfd97](https://github.com/TulipFarm/tulipfarm/commit/36bfd971af6090df6473cca0186351f7b6ff7102))
* **skills:** name the marketplace install action for its skill ([#529](https://github.com/TulipFarm/tulipfarm/issues/529)) ([8faa91c](https://github.com/TulipFarm/tulipfarm/commit/8faa91c8b99ef5dbd745f268e60321d3a99ffb46)), closes [#447](https://github.com/TulipFarm/tulipfarm/issues/447) [#464](https://github.com/TulipFarm/tulipfarm/issues/464) [#494](https://github.com/TulipFarm/tulipfarm/issues/494) [#496](https://github.com/TulipFarm/tulipfarm/issues/496), references [#446](https://github.com/TulipFarm/tulipfarm/issues/446) [#445](https://github.com/TulipFarm/tulipfarm/issues/445) [#446](https://github.com/TulipFarm/tulipfarm/issues/446) [#445](https://github.com/TulipFarm/tulipfarm/issues/445)
* **soul:** tolerate a bundled integration's manifest-less Soul dir ([#520](https://github.com/TulipFarm/tulipfarm/issues/520)) ([425d44d](https://github.com/TulipFarm/tulipfarm/commit/425d44d4919c6898e8bb178f1d513c56d3b39eae))
* **web:** buffer model sheet edits so a cleared Model ID cannot land ([#514](https://github.com/TulipFarm/tulipfarm/issues/514)) ([3e6383a](https://github.com/TulipFarm/tulipfarm/commit/3e6383a1ed4986749cff55380e4d6898020c7f32)), references [#430](https://github.com/TulipFarm/tulipfarm/issues/430) [#475](https://github.com/TulipFarm/tulipfarm/issues/475)
* **web:** correct Record field display and guard destructive actions ([#518](https://github.com/TulipFarm/tulipfarm/issues/518)) ([0e035d9](https://github.com/TulipFarm/tulipfarm/commit/0e035d9dcf148e900e3bcaaf8b09a8b3263777b8)), references [#440](https://github.com/TulipFarm/tulipfarm/issues/440) [#439](https://github.com/TulipFarm/tulipfarm/issues/439) [#410](https://github.com/TulipFarm/tulipfarm/issues/410) [#438](https://github.com/TulipFarm/tulipfarm/issues/438)
* **web:** keep chat auto-scroll inside the transcript container ([#527](https://github.com/TulipFarm/tulipfarm/issues/527)) ([50270b7](https://github.com/TulipFarm/tulipfarm/commit/50270b72759f435a56f6029e16b825829865f379)), references [#69](https://github.com/TulipFarm/tulipfarm/issues/69) [#420](https://github.com/TulipFarm/tulipfarm/issues/420)
* **web:** surface soul git sync status and give section pages an h1 ([#525](https://github.com/TulipFarm/tulipfarm/issues/525)) ([5baefc0](https://github.com/TulipFarm/tulipfarm/commit/5baefc068a97ca6cbe43a4a19903a37165d2d390)), closes [#414](https://github.com/TulipFarm/tulipfarm/issues/414) [#413](https://github.com/TulipFarm/tulipfarm/issues/413)
* **web:** target the login bounce at the route being loaded ([#526](https://github.com/TulipFarm/tulipfarm/issues/526)) ([a1a3914](https://github.com/TulipFarm/tulipfarm/commit/a1a39141415e1de5f5f3fa527bde81ac15c4d9c2)), closes [#403](https://github.com/TulipFarm/tulipfarm/issues/403) [#409](https://github.com/TulipFarm/tulipfarm/issues/409)

### Tests

* **resources:** pin the blank and barrier cases two bugs reported ([#528](https://github.com/TulipFarm/tulipfarm/issues/528)) ([cb21ca0](https://github.com/TulipFarm/tulipfarm/commit/cb21ca03ad52d7cdf354a8cf582bc37b6ea80a36)), references [#458](https://github.com/TulipFarm/tulipfarm/issues/458) [#434](https://github.com/TulipFarm/tulipfarm/issues/434) [#458](https://github.com/TulipFarm/tulipfarm/issues/458) [#500](https://github.com/TulipFarm/tulipfarm/issues/500) [#458](https://github.com/TulipFarm/tulipfarm/issues/458) [#434](https://github.com/TulipFarm/tulipfarm/issues/434) [#472](https://github.com/TulipFarm/tulipfarm/issues/472) [#458](https://github.com/TulipFarm/tulipfarm/issues/458) [#434](https://github.com/TulipFarm/tulipfarm/issues/434)
* **routines:** bind the forged one-off Trigger to the schedule dispatch ([#516](https://github.com/TulipFarm/tulipfarm/issues/516)) ([fdaaff1](https://github.com/TulipFarm/tulipfarm/commit/fdaaff176ad20b445ab39cafc1d650f06dbc17e4)), references [#467](https://github.com/TulipFarm/tulipfarm/issues/467) [#465](https://github.com/TulipFarm/tulipfarm/issues/465) [#503](https://github.com/TulipFarm/tulipfarm/issues/503) [#441](https://github.com/TulipFarm/tulipfarm/issues/441) [#406](https://github.com/TulipFarm/tulipfarm/issues/406) [#467](https://github.com/TulipFarm/tulipfarm/issues/467) [pre-#465](https://github.com/pre-/issues/465)

## [0.12.1](https://github.com/TulipFarm/tulipfarm/compare/v0.12.0...v0.12.1) (2026-08-20)

### Features

* **chat:** replace boxed run chrome with a Trace rail and persist asking Turns ([#505](https://github.com/TulipFarm/tulipfarm/issues/505)) ([b3be9ca](https://github.com/TulipFarm/tulipfarm/commit/b3be9ca7e5b6e9c5ebb9154225f9ee82ecb7ce96))

### Bug Fixes

* **eval:** synthesize real PDF bytes for application/pdf Case content ([#507](https://github.com/TulipFarm/tulipfarm/issues/507)) ([41c2e1e](https://github.com/TulipFarm/tulipfarm/commit/41c2e1e8c32dbc6d1b16a84b9b0983280648dc7b))
* **integrations:** thread Slack replies and drop invalid GitHub App events ([#509](https://github.com/TulipFarm/tulipfarm/issues/509)) ([7205c20](https://github.com/TulipFarm/tulipfarm/commit/7205c2028d11339a2199df9137bd1b19dca69e18))

## [0.12.0](https://github.com/TulipFarm/tulipfarm/compare/v0.11.0...v0.12.0) (2026-08-20)

### Features

* **files:** add file storage, uploads and multimodal chat ([#490](https://github.com/TulipFarm/tulipfarm/issues/490)) ([07b97f5](https://github.com/TulipFarm/tulipfarm/commit/07b97f50c12b56cbeda1619aa10b2d55f89b4289))
* **guardrails:** add a guardrail authoring surface ([#478](https://github.com/TulipFarm/tulipfarm/issues/478)) ([8e8afe0](https://github.com/TulipFarm/tulipfarm/commit/8e8afe0a6332f5781bfdf521fa5ad87a0d2797d9)), closes [#432](https://github.com/TulipFarm/tulipfarm/issues/432)
* **knowledge:** add graph retrieval and close Space ACL holes ([#459](https://github.com/TulipFarm/tulipfarm/issues/459)) ([3ca937a](https://github.com/TulipFarm/tulipfarm/commit/3ca937a6d24a663c053fa02b598f25f075b1363e))
* **system:** manage public integration origins ([#448](https://github.com/TulipFarm/tulipfarm/issues/448)) ([4a33682](https://github.com/TulipFarm/tulipfarm/commit/4a336822be90844de1dd078cc7d70f508edcc038))

### Bug Fixes

* **admin:** stop reporting a working llm provider as down ([#474](https://github.com/TulipFarm/tulipfarm/issues/474)) ([6c38824](https://github.com/TulipFarm/tulipfarm/commit/6c38824dadc9bbd380d3c69f4fbaf540705c4c82))
* **agent:** enforce Agent capability restrictions at dispatch ([#483](https://github.com/TulipFarm/tulipfarm/issues/483)) ([06e4158](https://github.com/TulipFarm/tulipfarm/commit/06e4158628dd38188741082be8b311e3e5c1ef30)), closes [#461](https://github.com/TulipFarm/tulipfarm/issues/461) [#462](https://github.com/TulipFarm/tulipfarm/issues/462)
* **api:** filter approval lists by decider authority ([#426](https://github.com/TulipFarm/tulipfarm/issues/426)) ([54c71a8](https://github.com/TulipFarm/tulipfarm/commit/54c71a82493fefff266cf126881638894504b393))
* **api:** treat malformed record ids as missing ([#449](https://github.com/TulipFarm/tulipfarm/issues/449)) ([e61425e](https://github.com/TulipFarm/tulipfarm/commit/e61425eff56d2a308673f7bbfcfba72e6af6c318))
* **auth:** owner access level admin ([#497](https://github.com/TulipFarm/tulipfarm/issues/497)) ([2cbf635](https://github.com/TulipFarm/tulipfarm/commit/2cbf6353a5d8fcaa936b2afed4711078b2c3d3c3)), closes [#444](https://github.com/TulipFarm/tulipfarm/issues/444)
* **authz:** enforce the Agent autonomy ceiling on every dispatch path ([#473](https://github.com/TulipFarm/tulipfarm/issues/473)) ([97d9bc8](https://github.com/TulipFarm/tulipfarm/commit/97d9bc831759cb42ad7cd42077dce79ed4ed85ac)), closes [#424](https://github.com/TulipFarm/tulipfarm/issues/424) [#431](https://github.com/TulipFarm/tulipfarm/issues/431)
* **authz:** make the Owner access level confer admin rights ([#471](https://github.com/TulipFarm/tulipfarm/issues/471)) ([45cae5a](https://github.com/TulipFarm/tulipfarm/commit/45cae5afcc3036e81425f99c9e7050ec8ac97e84))
* **chat:** never end a Turn without announcing it ([#485](https://github.com/TulipFarm/tulipfarm/issues/485)) ([a030dba](https://github.com/TulipFarm/tulipfarm/commit/a030dba2218edbc5516c06f645657086fcb7daa0)), closes [#427](https://github.com/TulipFarm/tulipfarm/issues/427)
* **chat:** pause turns for requested input ([#443](https://github.com/TulipFarm/tulipfarm/issues/443)) ([8dfd22c](https://github.com/TulipFarm/tulipfarm/commit/8dfd22cecc5902fb579296a628a9640538ff1b83))
* **chat:** run mentions as resolved agents ([#425](https://github.com/TulipFarm/tulipfarm/issues/425)) ([c258d4b](https://github.com/TulipFarm/tulipfarm/commit/c258d4b6f9e4fcf379de9cf5c96601bd93b722c0))
* **chat:** show knowledge mention states ([#450](https://github.com/TulipFarm/tulipfarm/issues/450)) ([b8c3788](https://github.com/TulipFarm/tulipfarm/commit/b8c3788c687624d0d41020a57395efb83cc2322f))
* **chat:** stop a Turn at request_input whatever it answers ([#500](https://github.com/TulipFarm/tulipfarm/issues/500)) ([f1a3820](https://github.com/TulipFarm/tulipfarm/commit/f1a38208f47b54ab3239188534c57f7d6f335033)), closes [#405](https://github.com/TulipFarm/tulipfarm/issues/405)
* **deps:** restore the undici 7.29.0 lockfile entry ([#484](https://github.com/TulipFarm/tulipfarm/issues/484)) ([df116ac](https://github.com/TulipFarm/tulipfarm/commit/df116ac90ded70c50c92d8a19d001bd3e1f22b85)), references [#479](https://github.com/TulipFarm/tulipfarm/issues/479) [#477](https://github.com/TulipFarm/tulipfarm/issues/477)
* **eval:** expose file_read/file_list as shipped platform Tools ([#504](https://github.com/TulipFarm/tulipfarm/issues/504)) ([83411c9](https://github.com/TulipFarm/tulipfarm/commit/83411c9e7968b1f119d39c3d304b2f5f584f7a8e))
* **llm:** report real provider reachability in the llm health check ([#502](https://github.com/TulipFarm/tulipfarm/issues/502)) ([031a140](https://github.com/TulipFarm/tulipfarm/commit/031a1407b2eed3ab73ae5a44abec853f849e2a1b))
* **models:** reject blank fallback provider and model ids ([#475](https://github.com/TulipFarm/tulipfarm/issues/475)) ([e36cf82](https://github.com/TulipFarm/tulipfarm/commit/e36cf8281d815f12cd5b7a85746f15e9967efd78))
* **models:** require fallback model ids ([#430](https://github.com/TulipFarm/tulipfarm/issues/430)) ([7f59056](https://github.com/TulipFarm/tulipfarm/commit/7f59056ebb1060d8cb996f63a2194f39062b55a1))
* **resources:** enforce required fields from the resource type wizard ([#472](https://github.com/TulipFarm/tulipfarm/issues/472)) ([53a9a69](https://github.com/TulipFarm/tulipfarm/commit/53a9a69ba101639cd602ae4a0218cd8d75a178c0)), closes [#456](https://github.com/TulipFarm/tulipfarm/issues/456) [#457](https://github.com/TulipFarm/tulipfarm/issues/457)
* **routines:** activate a publication before reporting the write live ([#503](https://github.com/TulipFarm/tulipfarm/issues/503)) ([88b7acd](https://github.com/TulipFarm/tulipfarm/commit/88b7acd4a59831fd9cffe2b6b79ec71a9dc243d3))
* **routines:** forge canonical published triggers ([#441](https://github.com/TulipFarm/tulipfarm/issues/441)) ([c5fcd4a](https://github.com/TulipFarm/tulipfarm/commit/c5fcd4a1956209fd8947b2b3f329c709b842f33c))
* **runtime:** distinguish skill categories ([#451](https://github.com/TulipFarm/tulipfarm/issues/451)) ([1323d06](https://github.com/TulipFarm/tulipfarm/commit/1323d069de4d00ab92557b5addff2cffb9638072))
* **sandbox:** drain hook workers before termination ([#452](https://github.com/TulipFarm/tulipfarm/issues/452)) ([006d772](https://github.com/TulipFarm/tulipfarm/commit/006d772748f4ad2256c6ace951ad4a0a8dcdafb1))
* **skill:** companion file install ([#494](https://github.com/TulipFarm/tulipfarm/issues/494)) ([5ebf3d8](https://github.com/TulipFarm/tulipfarm/commit/5ebf3d833ab921e3e6756599c8f7101e1e0c9553)), references [#483](https://github.com/TulipFarm/tulipfarm/issues/483)
* **skills:** identify scanned Skills by path through install ([#496](https://github.com/TulipFarm/tulipfarm/issues/496)) ([3730203](https://github.com/TulipFarm/tulipfarm/commit/3730203de3f8b4c1c1adeed86b3c7ca0b7f97f0b)), closes [#444](https://github.com/TulipFarm/tulipfarm/issues/444)
* **skills:** install Skill packages with companion files ([#464](https://github.com/TulipFarm/tulipfarm/issues/464)) ([11b6ab4](https://github.com/TulipFarm/tulipfarm/commit/11b6ab4c8c7f759192c65953734abade2bc7fa07))
* **soul:** publish forged Routines and report unpublished writes ([#465](https://github.com/TulipFarm/tulipfarm/issues/465)) ([78ed5dc](https://github.com/TulipFarm/tulipfarm/commit/78ed5dc84c843ba5be2bfe7d96b00253b6dc22ce))
* **tools:** cancel timed-out effect dispatches ([#428](https://github.com/TulipFarm/tulipfarm/issues/428)) ([3ebf95e](https://github.com/TulipFarm/tulipfarm/commit/3ebf95e1db14c699a51069a0d5eef8b16962235b))
* **tools:** cancel timed-out Tool calls instead of racing them ([#493](https://github.com/TulipFarm/tulipfarm/issues/493)) ([0ecf451](https://github.com/TulipFarm/tulipfarm/commit/0ecf451a745191a32cfb938e74c7ef49997272b0))
* **web:** expose degraded health details ([#442](https://github.com/TulipFarm/tulipfarm/issues/442)) ([cb17a62](https://github.com/TulipFarm/tulipfarm/commit/cb17a62bfacd20c5137dd8140d35e2784a3aa121))

### Documentation

* **qa:** add journey playbooks and run history to QA index ([#466](https://github.com/TulipFarm/tulipfarm/issues/466)) ([8f3f0ab](https://github.com/TulipFarm/tulipfarm/commit/8f3f0abd5a56d9c3aa92b910ed80fd0f75ecd017))
* restructure public docs into three reader tracks ([#455](https://github.com/TulipFarm/tulipfarm/issues/455)) ([08c9367](https://github.com/TulipFarm/tulipfarm/commit/08c9367e639b7f13d38d78134cb86879195f514e))

### Continuous Integration

* **container:** cache the Chromium download in the installer smoke ([#487](https://github.com/TulipFarm/tulipfarm/issues/487)) ([7b6f177](https://github.com/TulipFarm/tulipfarm/commit/7b6f177dd3748f32083a022b415869f563869b63))

### Maintenance

* **deps-dev:** bump @testing-library/jest-dom from 6.9.1 to 7.0.1 ([#470](https://github.com/TulipFarm/tulipfarm/issues/470)) ([45a5516](https://github.com/TulipFarm/tulipfarm/commit/45a55166bf11c7c8b786dbc98fe07e1caa866a67))
* **deps:** docs ([#491](https://github.com/TulipFarm/tulipfarm/issues/491)) ([332b79e](https://github.com/TulipFarm/tulipfarm/commit/332b79e43cbbd2785561cfb925a6066c448241d0))
* **deps:** misc ([#495](https://github.com/TulipFarm/tulipfarm/issues/495)) ([a6e6325](https://github.com/TulipFarm/tulipfarm/commit/a6e6325849b58cfcb2647a271fd1483621defad2))
* **deps:** refresh tiptap, ai sdk and test tooling ([#501](https://github.com/TulipFarm/tulipfarm/issues/501)) ([4b76903](https://github.com/TulipFarm/tulipfarm/commit/4b76903153b658bc4c993fd4fed324f2ca5cbce5))
* **deps:** typescript ([#499](https://github.com/TulipFarm/tulipfarm/issues/499)) ([18472ad](https://github.com/TulipFarm/tulipfarm/commit/18472ad95013397e890dd0c6c985410a757bd069))
* **deps:** upgrade biome, turbo, lefthook and lint-staged ([#476](https://github.com/TulipFarm/tulipfarm/issues/476)) ([f3242d6](https://github.com/TulipFarm/tulipfarm/commit/f3242d6043d1fb7d2ab3a17358a6dc4c0d0bbdb4))
* **deps:** upgrade commitlint and conventional-changelog ([#482](https://github.com/TulipFarm/tulipfarm/issues/482)) ([7425894](https://github.com/TulipFarm/tulipfarm/commit/742589464fb1cf743775d43a6e581d2327f2a640))
* **deps:** upgrade fastify and its plugins ([#480](https://github.com/TulipFarm/tulipfarm/issues/480)) ([a2e0f24](https://github.com/TulipFarm/tulipfarm/commit/a2e0f2415df046320555220376428790ff0dafc0))
* **deps:** upgrade pg, pg-boss and pglite ([#481](https://github.com/TulipFarm/tulipfarm/issues/481)) ([5ece0d0](https://github.com/TulipFarm/tulipfarm/commit/5ece0d00f111fad40e7861c2e17b1a477fc8cd06))
* **deps:** upgrade react, radix and lucide-react ([#486](https://github.com/TulipFarm/tulipfarm/issues/486)) ([1f651e8](https://github.com/TulipFarm/tulipfarm/commit/1f651e8de6e23a816b9829f09d83380960dd9117))
* **deps:** upgrade shiki to 4.4.3 ([#489](https://github.com/TulipFarm/tulipfarm/issues/489)) ([b20e07a](https://github.com/TulipFarm/tulipfarm/commit/b20e07a0a35ccd53da6dc7fa35d9a4b463257fe1))
* **deps:** upgrade the ai sdk group to latest ([#479](https://github.com/TulipFarm/tulipfarm/issues/479)) ([385214f](https://github.com/TulipFarm/tulipfarm/commit/385214f4dfe4aac4dd352f6a4e9890d1ee02a51b))
* **deps:** upgrade tiptap to 3.30.1 ([#488](https://github.com/TulipFarm/tulipfarm/issues/488)) ([3f6e0fe](https://github.com/TulipFarm/tulipfarm/commit/3f6e0fe694daa84b23b4e380c7dbad55471e5852))
* **deps:** upgrade vite, tsx and esbuild ([#492](https://github.com/TulipFarm/tulipfarm/issues/492)) ([dbbe95a](https://github.com/TulipFarm/tulipfarm/commit/dbbe95aa381fec751db080473591703be689f01e))
* **deps:** upgrade vitest, jsdom and testing-library ([#477](https://github.com/TulipFarm/tulipfarm/issues/477)) ([4ad600a](https://github.com/TulipFarm/tulipfarm/commit/4ad600af86ff43f3a52a9bf9536bec61e65c2747))

## [0.11.0](https://github.com/TulipFarm/tulipfarm/compare/v0.10.0...v0.11.0) (2026-08-18)

### Features

* **agent-runtime:** infer the auto effort preset from the prompt ([#369](https://github.com/TulipFarm/tulipfarm/issues/369)) ([c9f9d83](https://github.com/TulipFarm/tulipfarm/commit/c9f9d83f75e0652c7dc507ed1137333e410ebb7a))
* **architecture:** gate production reachability and ratchet L0 debt ([#386](https://github.com/TulipFarm/tulipfarm/issues/386)) ([27d3217](https://github.com/TulipFarm/tulipfarm/commit/27d32178f8170969501bdebac11c41488ea3e5da))
* evals ([#395](https://github.com/TulipFarm/tulipfarm/issues/395)) ([4a11c0a](https://github.com/TulipFarm/tulipfarm/commit/4a11c0a07123b7ede4f7f740302a52698afc5bd1))
* evals baseline ([#399](https://github.com/TulipFarm/tulipfarm/issues/399)) ([3c6e185](https://github.com/TulipFarm/tulipfarm/commit/3c6e185c1c1bbb346b612487ec2b782351ad93ab))
* evals matrix ([#396](https://github.com/TulipFarm/tulipfarm/issues/396)) ([e064b6a](https://github.com/TulipFarm/tulipfarm/commit/e064b6abf28fafcce36f8a92bf6c342eb7f84104))
* **llm:** close the L5 foundation-model hardening campaign ([#382](https://github.com/TulipFarm/tulipfarm/issues/382)) ([8261691](https://github.com/TulipFarm/tulipfarm/commit/82616913ee6880c5641d7e793314772f8d5b31e5))
* **llm:** request the prompt caching the model path already meters ([#383](https://github.com/TulipFarm/tulipfarm/issues/383)) ([909b2ca](https://github.com/TulipFarm/tulipfarm/commit/909b2ca70fe6b118ef17c7300c0e321e9493a3a2))
* **onboarding:** replace step-wizard setup with growing tulip + Companion quests ([#377](https://github.com/TulipFarm/tulipfarm/issues/377)) ([d6b0ca5](https://github.com/TulipFarm/tulipfarm/commit/d6b0ca5629c380ed1f56d8630d5da22b28cec9a2))
* **soul:** make the write gateway the only door to the authored tree ([#373](https://github.com/TulipFarm/tulipfarm/issues/373)) ([fdf9e19](https://github.com/TulipFarm/tulipfarm/commit/fdf9e19d55aecbf2c0848eeb155929f58061c074))
* **tasks:** setup Task system with auto-connect and reconcile kicks ([#384](https://github.com/TulipFarm/tulipfarm/issues/384)) ([ea5a4c9](https://github.com/TulipFarm/tulipfarm/commit/ea5a4c96e124bf5b165fc704ffd249e22e5c7b7d))
* **tool-broker:** make the mutation kill switch durable, installed and operable ([#376](https://github.com/TulipFarm/tulipfarm/issues/376)) ([d16ea50](https://github.com/TulipFarm/tulipfarm/commit/d16ea508a09c1d3605fc85ec3b01beaa11c1dbb0))
* upgrade memory and concile jobs ([#394](https://github.com/TulipFarm/tulipfarm/issues/394)) ([3d5d5d0](https://github.com/TulipFarm/tulipfarm/commit/3d5d5d00d44e7440f994797827b33cf454e3b9ac))
* **web:** add the Farm page as a living ASCII tulip field ([#391](https://github.com/TulipFarm/tulipfarm/issues/391)) ([695b04f](https://github.com/TulipFarm/tulipfarm/commit/695b04f8b9b79f03c5e7a9d1df11d193d175f449))
* **worker:** co-locate eligible Tools with the durable runtime ([#380](https://github.com/TulipFarm/tulipfarm/issues/380)) ([dd0e0e1](https://github.com/TulipFarm/tulipfarm/commit/dd0e0e1779a01b77d6897afc3c1b0e347cec1443))

### Bug Fixes

* **authz:** drop the dead member grant and pin the live role gate ([#388](https://github.com/TulipFarm/tulipfarm/issues/388)) ([171977d](https://github.com/TulipFarm/tulipfarm/commit/171977d134b17a919ce74710c1513c21789ea862))
* **ci:** cut queueing, kill the QEMU build hang, and drop duplicate work ([#370](https://github.com/TulipFarm/tulipfarm/issues/370)) ([83469d5](https://github.com/TulipFarm/tulipfarm/commit/83469d50d24b4b03ae01c52eaf1f1b58fd3c85d7))
* eval GHA run ([#397](https://github.com/TulipFarm/tulipfarm/issues/397)) ([abffaad](https://github.com/TulipFarm/tulipfarm/commit/abffaadb6583216021bc624cbddd18a589eaee4a))
* **eval:** count Cases not Trials in the Baseline delta summary ([#400](https://github.com/TulipFarm/tulipfarm/issues/400)) ([0966e37](https://github.com/TulipFarm/tulipfarm/commit/0966e37201d1f644d9e96d9942ed3e3a5cee9be8))
* **eval:** let a guard the model never reached be uncovered, not failed ([#398](https://github.com/TulipFarm/tulipfarm/issues/398)) ([929226c](https://github.com/TulipFarm/tulipfarm/commit/929226c9f28f96a6062b7f14f89ae0e58712bcca))
* **llm:** classify shed provider calls as unavailable  ([#387](https://github.com/TulipFarm/tulipfarm/issues/387)) ([f2e9a36](https://github.com/TulipFarm/tulipfarm/commit/f2e9a36040c0ee85cd21ea01a01daab49b898277))
* **runtime:** honor Routine retry and signal Surface render failures ([#390](https://github.com/TulipFarm/tulipfarm/issues/390)) ([c4e17f2](https://github.com/TulipFarm/tulipfarm/commit/c4e17f2f8cbbb00122b459e2def976206d5c0169))
* **runtime:** pin thread mappings and Agent-loop counters under concurrenc ([#389](https://github.com/TulipFarm/tulipfarm/issues/389)) ([5b98612](https://github.com/TulipFarm/tulipfarm/commit/5b98612601247277a7665c0dde1d20210ce32fe1))
* **tool-broker:** honour the declared adapter kind and cage egress destinations ([#385](https://github.com/TulipFarm/tulipfarm/issues/385)) ([189f53d](https://github.com/TulipFarm/tulipfarm/commit/189f53dcdfe866e514e3e4c13eb834c69397c273))

### Performance Improvements

* **api:** restore a migrated PGlite snapshot instead of replaying migrations ([#379](https://github.com/TulipFarm/tulipfarm/issues/379)) ([fe2c100](https://github.com/TulipFarm/tulipfarm/commit/fe2c1000b3bc5eb01e0573bd524023e7857fc7cc))
* **web:** fix blank first paint and cut critical path to 113 kB ([#374](https://github.com/TulipFarm/tulipfarm/issues/374)) ([68b74c0](https://github.com/TulipFarm/tulipfarm/commit/68b74c0c97c03eb28ffeb378e54e5047e6004b97))

### Documentation

* **agents:** make AGENTS.md navigation entry points and set comment policy ([#372](https://github.com/TulipFarm/tulipfarm/issues/372)) ([c36e90f](https://github.com/TulipFarm/tulipfarm/commit/c36e90fd279e3c343fa4f5280dd0ad93992cc1bd))
* turn README into a landing page, add contributor docs ([#371](https://github.com/TulipFarm/tulipfarm/issues/371)) ([7508c69](https://github.com/TulipFarm/tulipfarm/commit/7508c6973a9eb840bb8717203c598cfc0f63c3a8))

### Code Refactoring

* **integrations:** retire the unreachable Postgres Tool adapter ([#378](https://github.com/TulipFarm/tulipfarm/issues/378)) ([277ff6a](https://github.com/TulipFarm/tulipfarm/commit/277ff6aa9cac7c315ad2874a3d4c205af099f670))
* **runtime:** drop unread bounds and bind approvals to evidence ([#393](https://github.com/TulipFarm/tulipfarm/issues/393)) ([2bde301](https://github.com/TulipFarm/tulipfarm/commit/2bde301a63597e447832c20319226053860fa8f0))
* **runtime:** enforce controls that validated but never ran ([#392](https://github.com/TulipFarm/tulipfarm/issues/392)) ([5a36b0d](https://github.com/TulipFarm/tulipfarm/commit/5a36b0d43c557d91d33b6ac948c47f033ca45377))
* **soul:** move the soul domain into its package ([#381](https://github.com/TulipFarm/tulipfarm/issues/381)) ([ca1df03](https://github.com/TulipFarm/tulipfarm/commit/ca1df03267d532267f257da676f03e6f3f1151bb))

## [0.10.0](https://github.com/TulipFarm/tulipfarm/compare/v0.9.0...v0.10.0) (2026-08-14)

### Features

* **authz:** harden the effect plane and make access owner-editable ([#364](https://github.com/TulipFarm/tulipfarm/issues/364)) ([93cdf83](https://github.com/TulipFarm/tulipfarm/commit/93cdf83faf42f8233c004e58537c3f3bdf70757b))
* **bundle-store:** ship the publication producer and harden activation ([#363](https://github.com/TulipFarm/tulipfarm/issues/363)) ([823bdc8](https://github.com/TulipFarm/tulipfarm/commit/823bdc88e5917068bc5973995385634f15464938))
* cli harness: claude and codex support ([#365](https://github.com/TulipFarm/tulipfarm/issues/365)) ([92f0bf8](https://github.com/TulipFarm/tulipfarm/commit/92f0bf81c9354880fea9cf477c211aa0f6ddae53))
* **postgres:** harden database layer and expose the audit ledger ([#361](https://github.com/TulipFarm/tulipfarm/issues/361)) ([3142422](https://github.com/TulipFarm/tulipfarm/commit/3142422059f57becf5bca2e87f12968d513f7cd6))
* **soul:** route Soul writes through a validating gateway ([#360](https://github.com/TulipFarm/tulipfarm/issues/360)) ([2c18466](https://github.com/TulipFarm/tulipfarm/commit/2c1846625651705892adde82a76825ffaeef1b8a))

### Maintenance

* **ci:** remove Claude automation workflows, add README badges ([#366](https://github.com/TulipFarm/tulipfarm/issues/366)) ([08a8bd1](https://github.com/TulipFarm/tulipfarm/commit/08a8bd14a206130a6d686426da1bf34b78139677))

## [0.9.0](https://github.com/TulipFarm/tulipfarm/compare/v0.8.2...v0.9.0) (2026-08-10)

### Features

* **chat:** redesign tool calls as trace runs and persist them ([#354](https://github.com/TulipFarm/tulipfarm/issues/354)) ([bd329ae](https://github.com/TulipFarm/tulipfarm/commit/bd329aee10b3de1eab7fed5e4d0f0139fed959b8))
* **integrations:** add github_issue_create and github_repository_create tools ([#355](https://github.com/TulipFarm/tulipfarm/issues/355)) ([4c20077](https://github.com/TulipFarm/tulipfarm/commit/4c20077dc749f8a970541f92aefa6a1d9f4f4925))
* **observability:** show error logs and per-service resource usage in the UI ([#358](https://github.com/TulipFarm/tulipfarm/issues/358)) ([4012719](https://github.com/TulipFarm/tulipfarm/commit/401271909ba0a22dafb7e98310c961310f10aa77))
* **web:** split personal settings from business configuration ([#357](https://github.com/TulipFarm/tulipfarm/issues/357)) ([b350bf3](https://github.com/TulipFarm/tulipfarm/commit/b350bf321d99a6e5b98fcca5cc7dada252c4894d))

### Bug Fixes

* **knowledge:** stop Slack history sync wedging on large channels, fix tool routing ([#356](https://github.com/TulipFarm/tulipfarm/issues/356)) ([1a51313](https://github.com/TulipFarm/tulipfarm/commit/1a51313ddc8fb28e41e92c58b1d2df158251ffad))

## [0.8.2](https://github.com/TulipFarm/tulipfarm/compare/v0.8.1...v0.8.2) (2026-08-10)

### Bug Fixes

* **ci:** update buildx cache-to to mode=min and ignore-error=true ([#351](https://github.com/TulipFarm/tulipfarm/issues/351)) ([aba785b](https://github.com/TulipFarm/tulipfarm/commit/aba785ba4941508f636f63b8ab2ce254a465a02f))
* **system:** allow runtime version env override over build constant ([#352](https://github.com/TulipFarm/tulipfarm/issues/352)) ([d7a0625](https://github.com/TulipFarm/tulipfarm/commit/d7a0625d7a45801329ac903b1d05cd5078ed73cd))

## [0.8.1](https://github.com/TulipFarm/tulipfarm/compare/v0.8.0...v0.8.1) (2026-08-10)

### Bug Fixes

* **ci:** improve release pipeline reliability, speed, and ancestry checks ([#349](https://github.com/TulipFarm/tulipfarm/issues/349)) ([26bbf18](https://github.com/TulipFarm/tulipfarm/commit/26bbf1865a933b4f39afca4565557c611e672c1f))

### Documentation

* **qa:** expand QA playbooks to 23 playbooks and fix agents list heading ([#348](https://github.com/TulipFarm/tulipfarm/issues/348)) ([3b611f6](https://github.com/TulipFarm/tulipfarm/commit/3b611f63c4384349ab0ce9d999887b1e00239507))

## [0.8.0](https://github.com/TulipFarm/tulipfarm/compare/v0.7.0...v0.8.0) (2026-08-09)

### Features

* **integrations:** make integrations declarative and redesign the UI ([#344](https://github.com/TulipFarm/tulipfarm/issues/344)) ([5e501aa](https://github.com/TulipFarm/tulipfarm/commit/5e501aad97e4946e4176fc0659d81c525e215c19))
* **memory:** promote packages/memory to the live memory engine ([#342](https://github.com/TulipFarm/tulipfarm/issues/342)) ([67e6481](https://github.com/TulipFarm/tulipfarm/commit/67e648191977951d3ba24acd64d164dbdc12b06a))
* **skills:** add sandboxed script and CLI execution ([#343](https://github.com/TulipFarm/tulipfarm/issues/343)) ([2ba5886](https://github.com/TulipFarm/tulipfarm/commit/2ba588691c914f75f0e69dcfce3b65974ba5d219))

### Bug Fixes

* qa and multiple smoke fixes ([#346](https://github.com/TulipFarm/tulipfarm/issues/346)) ([400fde3](https://github.com/TulipFarm/tulipfarm/commit/400fde36861a53b754bd73fb093f2617ff8aac06))

## [0.7.0](https://github.com/TulipFarm/tulipfarm/compare/v0.6.1...v0.7.0) (2026-08-08)

### Features

* **agent-runtime:** give agents the current date and time ([#338](https://github.com/TulipFarm/tulipfarm/issues/338)) ([dea9293](https://github.com/TulipFarm/tulipfarm/commit/dea9293ad3c5798356c9712f81ddd0e0ed1d9e87))
* **agent-runtime:** narrow offered tools to the active Skill's scope ([#339](https://github.com/TulipFarm/tulipfarm/issues/339)) ([e64e178](https://github.com/TulipFarm/tulipfarm/commit/e64e1789dbd3a2dafa3ddcf8d114b3787b7990c8))
* **llm:** converge model selection onto ModelProfile routing ([#340](https://github.com/TulipFarm/tulipfarm/issues/340)) ([c1a6c72](https://github.com/TulipFarm/tulipfarm/commit/c1a6c72631ba00295a00eb6bf29d698171efd459))
* **web:** rebuild the app shell rail, sidebar, and top bar ([#334](https://github.com/TulipFarm/tulipfarm/issues/334)) ([3eb0b16](https://github.com/TulipFarm/tulipfarm/commit/3eb0b16f8dcba9063bc0329f54006374c6a1667d))

## [0.6.1](https://github.com/TulipFarm/tulipfarm/compare/v0.6.0...v0.6.1) (2026-08-08)

### Features

* **integrations:** add send_slack_message chat tool with thread-reply continuity ([#336](https://github.com/TulipFarm/tulipfarm/issues/336)) ([e041785](https://github.com/TulipFarm/tulipfarm/commit/e041785b974d5110b959ec4432e013a1ab04d732))

### Documentation

* overhaul public docs for v0.6.0 ([#335](https://github.com/TulipFarm/tulipfarm/issues/335)) ([459ca56](https://github.com/TulipFarm/tulipfarm/commit/459ca568693446ab4c4b59d14239db9202a808c6))

## [0.6.0](https://github.com/TulipFarm/tulipfarm/compare/v0.5.1...v0.6.0) (2026-08-07)

### Features

* **auth:** replace temporary passwords with invite links ([#330](https://github.com/TulipFarm/tulipfarm/issues/330)) ([5aa4f18](https://github.com/TulipFarm/tulipfarm/commit/5aa4f186a962fb244576b700ba12a3d12daff948))
* **integrations:** wire GitHub tools into chat with live-rendered surfaces ([#331](https://github.com/TulipFarm/tulipfarm/issues/331)) ([36bc109](https://github.com/TulipFarm/tulipfarm/commit/36bc109572c66c8bcab265d1c23140f2a54d61f1))

### Bug Fixes

* **api:** reply into the Slack thread after a Surface interaction resolves ([#325](https://github.com/TulipFarm/tulipfarm/issues/325)) ([a453d41](https://github.com/TulipFarm/tulipfarm/commit/a453d41f2bee613a175b14320856691a87bfd62b))
* **install:** bump TULIPFARM_VERSION on re-run and log resolved tag ([#323](https://github.com/TulipFarm/tulipfarm/issues/323)) ([c1defd0](https://github.com/TulipFarm/tulipfarm/commit/c1defd01e9826c4205e2c2fcd5a4fb11a29c3af9))
* **integrations:** resolve Slack mention tokens before agent turn ([#326](https://github.com/TulipFarm/tulipfarm/issues/326)) ([9ca784a](https://github.com/TulipFarm/tulipfarm/commit/9ca784a9e3e2e74935f5aca0ae1429ddc736d156))
* **release:** exclude non-conventional commits from changelog instead of blocking ([#332](https://github.com/TulipFarm/tulipfarm/issues/332)) ([3930d37](https://github.com/TulipFarm/tulipfarm/commit/3930d372ba3ed943a533ebb440a2a1dc45796498)), closes [#N](https://github.com/TulipFarm/tulipfarm/issues/N)

### Reverts

* Revert "feat(web): redesign chat UI and update design system skill (#320)" (#324) ([1d796ce](https://github.com/TulipFarm/tulipfarm/commit/1d796ce9578548c004f70dcce34c1b96b06a2bce)), closes [#320](https://github.com/TulipFarm/tulipfarm/issues/320) [#324](https://github.com/TulipFarm/tulipfarm/issues/324)

### Code Refactoring

* **routines:** delete the retired Routine engine ([#327](https://github.com/TulipFarm/tulipfarm/issues/327)) ([05e3c2b](https://github.com/TulipFarm/tulipfarm/commit/05e3c2b54635aa236f3d2d691924e6c048d94dfe))
* **surface-web:** flatten renderer dispatch and dedup markup ([#328](https://github.com/TulipFarm/tulipfarm/issues/328)) ([8bef3b0](https://github.com/TulipFarm/tulipfarm/commit/8bef3b077cdd2c3b6b373d10e2d30ae8b03c318d))

## [0.5.1](https://github.com/TulipFarm/tulipfarm/compare/v0.5.0...v0.5.1) (2026-08-06)

### Features

* **web:** redesign chat UI and update design system skill ([#320](https://github.com/TulipFarm/tulipfarm/issues/320)) ([56b10a5](https://github.com/TulipFarm/tulipfarm/commit/56b10a584305ec56218cea26f44973c3a57c29a7))

### Bug Fixes

* **docker:** ship bundled integrations directory into runtime image ([#321](https://github.com/TulipFarm/tulipfarm/issues/321)) ([808089d](https://github.com/TulipFarm/tulipfarm/commit/808089d0af5850ee6924aaa6e1973c89bfb7a648))

## [0.5.0](https://github.com/TulipFarm/tulipfarm/compare/v0.4.4...v0.5.0) (2026-08-06)

### Features

* **auth:** admin user management with forced password reset ([#317](https://github.com/TulipFarm/tulipfarm/issues/317)) ([c0b2010](https://github.com/TulipFarm/tulipfarm/commit/c0b2010f63358bae01f48eea9ebce69e0c183432))
* **integration-worker:** boot the process ([#307](https://github.com/TulipFarm/tulipfarm/issues/307)) ([d785078](https://github.com/TulipFarm/tulipfarm/commit/d785078e1e3ab16778fd48de4be25b7045642b91))
* **integration-worker:** rich Slack Block Kit UI via Surface system ([#310](https://github.com/TulipFarm/tulipfarm/issues/310)) ([4392767](https://github.com/TulipFarm/tulipfarm/commit/43927676440301a68c64c62bcf9c87b6a081caef))
* **security:** fix high and medium severity findings from security audit ([#315](https://github.com/TulipFarm/tulipfarm/issues/315)) ([e0a6e29](https://github.com/TulipFarm/tulipfarm/commit/e0a6e2904ff38946c43cafe4148eaff9e788e950))
* **soul:** persist execution bundles ([#292](https://github.com/TulipFarm/tulipfarm/issues/292)) ([5369048](https://github.com/TulipFarm/tulipfarm/commit/5369048fdccfb1b26514bd7e98d3c70f7e4de48e))
* **web:** establish design system shell ([#296](https://github.com/TulipFarm/tulipfarm/issues/296)) ([aa90d66](https://github.com/TulipFarm/tulipfarm/commit/aa90d66f138ef2faaba9962c0aa711e150d27f8b))
* **web:** refine chat shell and composer ([#299](https://github.com/TulipFarm/tulipfarm/issues/299)) ([77c4cd3](https://github.com/TulipFarm/tulipfarm/commit/77c4cd32be7256848a2fcd38543edd88beb2b0fc))
* **worker:** answer Routine agent States from the pinned bundle ([#304](https://github.com/TulipFarm/tulipfarm/issues/304)) ([98c5a01](https://github.com/TulipFarm/tulipfarm/commit/98c5a01ee7fb18b84d859609b0b89abb43a15749))
* **worker:** dispatch Routine Tool States through the broker ([#302](https://github.com/TulipFarm/tulipfarm/issues/302)) ([8b09bfc](https://github.com/TulipFarm/tulipfarm/commit/8b09bfcf273241d5ff0d5f2b5e35a660ddc8a251))
* **worker:** own turn execution and stream every channel from run_events ([#286](https://github.com/TulipFarm/tulipfarm/issues/286)) ([2efccec](https://github.com/TulipFarm/tulipfarm/commit/2efccec2c2957a5224cbb9033bfbfc3d0c9a1559))
* **worker:** park Routine approval States on durable waits ([#303](https://github.com/TulipFarm/tulipfarm/issues/303)) ([1d5abc9](https://github.com/TulipFarm/tulipfarm/commit/1d5abc9d60ff2744d68b7c79249e33e29aaca975))

### Bug Fixes

* **chat:** budget the turn routes per caller ([#288](https://github.com/TulipFarm/tulipfarm/issues/288)) ([00e22a0](https://github.com/TulipFarm/tulipfarm/commit/00e22a0a4a225b655271a3553e6ee2d583d22347))
* **deps:** apply security patches and overrides ([#316](https://github.com/TulipFarm/tulipfarm/issues/316)) ([fa86035](https://github.com/TulipFarm/tulipfarm/commit/fa860350dc126895ca0821fea147ba924e10d701))
* **web:** guard secure-context-only browser APIs ([#285](https://github.com/TulipFarm/tulipfarm/issues/285)) ([5471c47](https://github.com/TulipFarm/tulipfarm/commit/5471c47ea28a5fa979bcbbf8d0b7fa6e3dfb43ad))

### Code Refactoring

* **api:** compose hookIngress signed webhook Trigger consumption ([#306](https://github.com/TulipFarm/tulipfarm/issues/306)) ([87e0c42](https://github.com/TulipFarm/tulipfarm/commit/87e0c42f4966213a62f7382c03e85148220eb03a))
* **api:** compose triggerInvoke Trigger consumption ([#305](https://github.com/TulipFarm/tulipfarm/issues/305)) ([a460112](https://github.com/TulipFarm/tulipfarm/commit/a4601120d4980b8c01a685c8a74576d911149069))
* **routines:** pin Runs to active Soul bundles ([#295](https://github.com/TulipFarm/tulipfarm/issues/295)) ([4d10023](https://github.com/TulipFarm/tulipfarm/commit/4d10023b65efce97ae720426a752f1140ab7d9ed))
* **run-kernel:** own durable invocation boundary ([#293](https://github.com/TulipFarm/tulipfarm/issues/293)) ([dda3e5d](https://github.com/TulipFarm/tulipfarm/commit/dda3e5daf094aa00fa045d1f2b835d32e8a372af))
* **run-kernel:** schedule durable Routine States ([#298](https://github.com/TulipFarm/tulipfarm/issues/298)) ([b6dfcce](https://github.com/TulipFarm/tulipfarm/commit/b6dfcce916378fac4cd68d83cd58d7ae4a0594d4))
* **runs:** separate source from routine identity ([#294](https://github.com/TulipFarm/tulipfarm/issues/294)) ([bed4a24](https://github.com/TulipFarm/tulipfarm/commit/bed4a2484b4582e66b72fdacf4f6105f35df4be1))
* **worker:** execute deterministic routine branches ([#300](https://github.com/TulipFarm/tulipfarm/issues/300)) ([88c011a](https://github.com/TulipFarm/tulipfarm/commit/88c011acfe19702d8a0f6b11764a3814eeb357a8))
* **worker:** execute Routine waits and bounded fan-out ([#301](https://github.com/TulipFarm/tulipfarm/issues/301)) ([7bc64b0](https://github.com/TulipFarm/tulipfarm/commit/7bc64b00b5a9cd5d5332f3f89c43c2961c8f6a18))
* **worker:** host maintenance jobs ([#290](https://github.com/TulipFarm/tulipfarm/issues/290)) ([304ebd5](https://github.com/TulipFarm/tulipfarm/commit/304ebd5b54420bd0979ec7221fea1a083765c899))
* **worker:** load exact Routine definitions ([#297](https://github.com/TulipFarm/tulipfarm/issues/297)) ([33cd399](https://github.com/TulipFarm/tulipfarm/commit/33cd399d3a5175a4f4d30a2bc128fdcb16d061c5))

### Tests

* **ci:** add browser smoke against the installed image and a secure-context guard ([#287](https://github.com/TulipFarm/tulipfarm/issues/287)) ([c25cebe](https://github.com/TulipFarm/tulipfarm/commit/c25cebea39f29ee35402f21fd1d9bf019a665400))
* **e2e:** expand production product coverage ([#291](https://github.com/TulipFarm/tulipfarm/issues/291)) ([d31a7d9](https://github.com/TulipFarm/tulipfarm/commit/d31a7d936a1118459b24a667f2e19b17c92a89f0))

### Maintenance

* **deps:** bump actions/setup-node from 6 to 7 in the actions group ([#311](https://github.com/TulipFarm/tulipfarm/issues/311)) ([cb45f99](https://github.com/TulipFarm/tulipfarm/commit/cb45f99700bf8ae161eac489c3a6ed322d59ed2c))
* remove internal spec/phase/ticket-code jargon repo-wide ([#308](https://github.com/TulipFarm/tulipfarm/issues/308)) ([9980a8b](https://github.com/TulipFarm/tulipfarm/commit/9980a8b9119d282a40eb7fce8ccc853c7a0606eb))

## [0.4.4](https://github.com/TulipFarm/tulipfarm/compare/v0.4.3...v0.4.4) (2026-07-30)

### Features

* **chat:** persist every request as an Artifact and submit turns durably ([#282](https://github.com/TulipFarm/tulipfarm/issues/282)) ([f5da11d](https://github.com/TulipFarm/tulipfarm/commit/f5da11dc672bbad593f48f7764fe40e767f9e348))

### Bug Fixes

* **web:** allow unsafe-eval in prod CSP for Ajv schema compilation ([#283](https://github.com/TulipFarm/tulipfarm/issues/283)) ([bac9434](https://github.com/TulipFarm/tulipfarm/commit/bac94349b2580103cc90d4bbd6b372f55a3ecabf))

## [0.4.3](https://github.com/TulipFarm/tulipfarm/compare/v0.4.2...v0.4.3) (2026-07-30)

### Features

* **installer:** add production uninstaller ([#279](https://github.com/TulipFarm/tulipfarm/issues/279)) ([f153005](https://github.com/TulipFarm/tulipfarm/commit/f153005dc7ec384c5f74bfcb6cb1debaff5cbb83))
* **worker:** boot the durable worker and close the orphan-Run leak ([#277](https://github.com/TulipFarm/tulipfarm/issues/277)) ([da2b610](https://github.com/TulipFarm/tulipfarm/commit/da2b61063277a8ef9a95da9b17cdfb048514e519))

### Bug Fixes

* **installer:** handle occupied host ports ([#278](https://github.com/TulipFarm/tulipfarm/issues/278)) ([c594fd5](https://github.com/TulipFarm/tulipfarm/commit/c594fd5a15486c64dae79feac57eba10dc2fd3fd))
* **release:** restore per-version changelogs ([#280](https://github.com/TulipFarm/tulipfarm/issues/280)) ([98d63b5](https://github.com/TulipFarm/tulipfarm/commit/98d63b58176d42cc1748f9230b8f36244373733d))

## [0.4.2](https://github.com/TulipFarm/tulipfarm/compare/v0.4.1...v0.4.2) (2026-07-29)

## [0.4.1](https://github.com/TulipFarm/tulipfarm/compare/v0.4.0...v0.4.1) (2026-07-29)

## [0.4.0](https://github.com/TulipFarm/tulipfarm/compare/v0.3.0-integrations.1...v0.4.0) (2026-07-29)

### Features

* **a2ui:** add governed forms and Routine authoring ([#254](https://github.com/TulipFarm/tulipfarm/issues/254)) ([593a7c3](https://github.com/TulipFarm/tulipfarm/commit/593a7c3e12a6446e371e21699f2d3ba8d7647f31))
* **agent-runtime:** add bounded Agent loop, durable Turns, delegation, and eval gate ([#243](https://github.com/TulipFarm/tulipfarm/issues/243)) ([e02d409](https://github.com/TulipFarm/tulipfarm/commit/e02d4096ac4e2787d978835f508418830d346da4))
* **agent-runtime:** add model routing, context assembly, and Skill resolution ([#242](https://github.com/TulipFarm/tulipfarm/issues/242)) ([16fcca5](https://github.com/TulipFarm/tulipfarm/commit/16fcca538b9456fc87a5528d8a3e60fcf06bde14))
* **approvals:** persist exact approval bindings and one-use decisions ([#228](https://github.com/TulipFarm/tulipfarm/issues/228)) ([d90dc88](https://github.com/TulipFarm/tulipfarm/commit/d90dc88ffa52fbf7ac61c676d6b25f5b9bd36335))
* **audit:** append-only hash-linked audit ledger ([#225](https://github.com/TulipFarm/tulipfarm/issues/225)) ([ee2bad6](https://github.com/TulipFarm/tulipfarm/commit/ee2bad6569ec0b0acd6e32e0511fc52e4f48aab9))
* **audit:** seal, retain, export, and erase audit evidence ([#227](https://github.com/TulipFarm/tulipfarm/issues/227)) ([bf26fe9](https://github.com/TulipFarm/tulipfarm/commit/bf26fe9464d5205ce0fd3b1d9b367b4ae9903e9d))
* **authz:** composable user/Agent roles, scoped grants, and intersection decisions ([#222](https://github.com/TulipFarm/tulipfarm/issues/222)) ([b06b25d](https://github.com/TulipFarm/tulipfarm/commit/b06b25dab659105d41831492d4a5bd0dd4a3c95d))
* **authz:** default-deny Guardrail engine, risk ceilings, and DLP boundary decisions ([#223](https://github.com/TulipFarm/tulipfarm/issues/223)) ([a652a23](https://github.com/TulipFarm/tulipfarm/commit/a652a232479203ad7b903a3f771f9398174bd89f))
* **authz:** guest, JIT, external-identity, and recertification primitives ([#224](https://github.com/TulipFarm/tulipfarm/issues/224)) ([1ad5818](https://github.com/TulipFarm/tulipfarm/commit/1ad581896ad381210c5a029c332f8429b5188343))
* **authz:** persist principal and session ports with business_id scoping ([#221](https://github.com/TulipFarm/tulipfarm/issues/221)) ([506db60](https://github.com/TulipFarm/tulipfarm/commit/506db607ffb79c8dbf890cdcd8538ea9adc890bf))
* **channels:** add durable Slack and Telegram adapters ([#251](https://github.com/TulipFarm/tulipfarm/issues/251)) ([57a63ac](https://github.com/TulipFarm/tulipfarm/commit/57a63acfc37123c2c710d5aa730fe05894a95cda))
* **chat:** unify normal chat harness ([#246](https://github.com/TulipFarm/tulipfarm/issues/246)) ([c30dc4e](https://github.com/TulipFarm/tulipfarm/commit/c30dc4e8fc2faa675bda9f4515fd38e1b7e82307))
* **deploy:** add zero-config container boot ([#266](https://github.com/TulipFarm/tulipfarm/issues/266)) ([c7d5425](https://github.com/TulipFarm/tulipfarm/commit/c7d5425a4ab0120513913150bfa60ff6afc29858))
* **events:** add transactional inbox and outbox ([#232](https://github.com/TulipFarm/tulipfarm/issues/232)) ([86c5034](https://github.com/TulipFarm/tulipfarm/commit/86c5034f4ddb693f338016180a57fa1c5340148b))
* **identity:** expose hardened authentication and identity APIs ([#230](https://github.com/TulipFarm/tulipfarm/issues/230)) ([c500baf](https://github.com/TulipFarm/tulipfarm/commit/c500baff60f60fded68a4e59b1676c1a7bf46f51))
* **integrations:** add GitHub and Jira adapters with scoped authority ([#247](https://github.com/TulipFarm/tulipfarm/issues/247)) ([22ac55f](https://github.com/TulipFarm/tulipfarm/commit/22ac55f0d2a907878d74b93140771a3b956e3502)), closes [#248](https://github.com/TulipFarm/tulipfarm/issues/248)
* **integrations:** add governed integration packaging ([#255](https://github.com/TulipFarm/tulipfarm/issues/255)) ([ec2b597](https://github.com/TulipFarm/tulipfarm/commit/ec2b59756e1a8912032ac5f7705d7f06035d0d7c))
* **knowledge,memory:** add ACL-first retrieval and scoped memory assertions ([#252](https://github.com/TulipFarm/tulipfarm/issues/252)) ([1d40a55](https://github.com/TulipFarm/tulipfarm/commit/1d40a55b98ec88da9dd81ed485b89799a0096e6e)), closes [#253](https://github.com/TulipFarm/tulipfarm/issues/253)
* **llm-settings:** fetch model list from LiteLLM proxy API for openai-compatible providers ([#186](https://github.com/TulipFarm/tulipfarm/issues/186)) ([fe41be4](https://github.com/TulipFarm/tulipfarm/commit/fe41be46f1cc3b35745ca318804cee916da65c3e))
* **operations:** add API and responsive shell foundation ([#249](https://github.com/TulipFarm/tulipfarm/issues/249)) ([6402c70](https://github.com/TulipFarm/tulipfarm/commit/6402c705f2528b845ddb955f3b0ae74d1c706646)), closes [#250](https://github.com/TulipFarm/tulipfarm/issues/250)
* **operations:** compose the operational API into the running server ([#264](https://github.com/TulipFarm/tulipfarm/issues/264)) ([190872b](https://github.com/TulipFarm/tulipfarm/commit/190872bd9ffb74562f66b498e2bf79295f2ab033))
* **ports:** define provider-neutral infrastructure ports ([#208](https://github.com/TulipFarm/tulipfarm/issues/208)) ([258b83a](https://github.com/TulipFarm/tulipfarm/commit/258b83aa857353007791e524d8377403b5bb050d))
* **routines:** add Routine and Run visualization ([#166](https://github.com/TulipFarm/tulipfarm/issues/166)) ([539121e](https://github.com/TulipFarm/tulipfarm/commit/539121e02dfdd75f19ebb0120fe0021d15f9838b))
* **run-kernel:** add durable worker leases and Run dispatch ([#234](https://github.com/TulipFarm/tulipfarm/issues/234)) ([b73d56e](https://github.com/TulipFarm/tulipfarm/commit/b73d56e05b6271ed42005d87d14dea71b1b06a49))
* **run-kernel:** add Routine compiler, State processors, and Trigger ingress ([#244](https://github.com/TulipFarm/tulipfarm/issues/244)) ([81dcd1a](https://github.com/TulipFarm/tulipfarm/commit/81dcd1a9072629ecffb3441af8dd5bf0bd5b6179)), closes [#245](https://github.com/TulipFarm/tulipfarm/issues/245)
* **run-kernel:** enforce Run limits, budgets, concurrency, and cancellation ([#238](https://github.com/TulipFarm/tulipfarm/issues/238)) ([c45c640](https://github.com/TulipFarm/tulipfarm/commit/c45c64047ff22bd11f44af67792e6417f0b84c6a)), closes [#239](https://github.com/TulipFarm/tulipfarm/issues/239)
* **run-kernel:** implement durable waits, timers, and resume tokens ([#237](https://github.com/TulipFarm/tulipfarm/issues/237)) ([d13fd46](https://github.com/TulipFarm/tulipfarm/commit/d13fd461c6e754a1bc3a6800fbdd56b54e2b6602))
* **run-kernel:** implement immutable typed outputs and Artifacts ([#235](https://github.com/TulipFarm/tulipfarm/issues/235)) ([3ec5cf0](https://github.com/TulipFarm/tulipfarm/commit/3ec5cf0595c5cc84ce2f0cf53d38150c662b9fd6))
* **run-kernel:** persist runs states attempts and lineage ([#233](https://github.com/TulipFarm/tulipfarm/issues/233)) ([b8695bf](https://github.com/TulipFarm/tulipfarm/commit/b8695bfcce78f5703512188e9578fbacf1f1b931))
* **runtime:** complete resilience cutover ([#256](https://github.com/TulipFarm/tulipfarm/issues/256)) ([a3bd74a](https://github.com/TulipFarm/tulipfarm/commit/a3bd74a92ea38b069bb5666761dfc292e09c737f))
* **sandbox:** add isolated skill execution protocol ([#241](https://github.com/TulipFarm/tulipfarm/issues/241)) ([1031638](https://github.com/TulipFarm/tulipfarm/commit/10316380e29356d498a342276d9e4a9d0bc330ce))
* scaffold package boundaries ([#202](https://github.com/TulipFarm/tulipfarm/issues/202)) ([6c28e05](https://github.com/TulipFarm/tulipfarm/commit/6c28e05c57d93ebdf58f564408cb59eec450a946))
* **schema:** add strict schema registry ([#210](https://github.com/TulipFarm/tulipfarm/issues/210)) ([12ab5e4](https://github.com/TulipFarm/tulipfarm/commit/12ab5e4036d1b00e734b5fca1e022aa7ca6b04c9))
* **schema:** define Agent, Skill, ToolContract, and ModelProfile schemas ([#211](https://github.com/TulipFarm/tulipfarm/issues/211)) ([27d7aa5](https://github.com/TulipFarm/tulipfarm/commit/27d7aa5c76bfdb0ed805a063849987011b6940c9))
* **schema:** define governance and integration schemas ([#213](https://github.com/TulipFarm/tulipfarm/issues/213)) ([be48bbb](https://github.com/TulipFarm/tulipfarm/commit/be48bbb831f4f93c69a33543b69a43b8792d9614))
* **schema:** define Routine, Trigger, and EventEnvelope schemas ([#212](https://github.com/TulipFarm/tulipfarm/issues/212)) ([362934d](https://github.com/TulipFarm/tulipfarm/commit/362934d04c1aefefb059429ac9d4bbfbeae411bc))
* **secrets:** build scoped Secret Broker ([#229](https://github.com/TulipFarm/tulipfarm/issues/229)) ([ed6b4d7](https://github.com/TulipFarm/tulipfarm/commit/ed6b4d798ff959019404507895d6cc08e0930c9b))
* **skills:** add bundled Skill overlay ([#260](https://github.com/TulipFarm/tulipfarm/issues/260)) ([3ea871c](https://github.com/TulipFarm/tulipfarm/commit/3ea871c599954775a24cb0e3f9f6b6a6f7d4e170))
* **skills:** add catalog categories and update checks ([#261](https://github.com/TulipFarm/tulipfarm/issues/261)) ([1894148](https://github.com/TulipFarm/tulipfarm/commit/1894148aab7e2e6b85f6d8afe621179a9b3b35d0))
* **skills:** add deterministic audit guard ([#262](https://github.com/TulipFarm/tulipfarm/issues/262)) ([d5ba45c](https://github.com/TulipFarm/tulipfarm/commit/d5ba45ceb6a61ba3ef78328174fabe004848dba6))
* **skills:** add self-improvement workflow ([#263](https://github.com/TulipFarm/tulipfarm/issues/263)) ([5f640d6](https://github.com/TulipFarm/tulipfarm/commit/5f640d6116c8039db5b468951e4f7b4fbcf1388e))
* **skills:** add Skill frontmatter validation ([#259](https://github.com/TulipFarm/tulipfarm/issues/259)) ([5f6ca1c](https://github.com/TulipFarm/tulipfarm/commit/5f6ca1ce771ea7e6be907643e406f85cbe77ae76))
* **soul:** add fail-closed changeset validation ([#215](https://github.com/TulipFarm/tulipfarm/issues/215)) ([9c8e0bd](https://github.com/TulipFarm/tulipfarm/commit/9c8e0bd230cf8fe9c932ac3d2294eb284eccc1fc))
* **soul:** add manual /api/v1/soul/reload endpoint ([#184](https://github.com/TulipFarm/tulipfarm/issues/184)) ([c70b0cd](https://github.com/TulipFarm/tulipfarm/commit/c70b0cd41d7c5b2851a3973f7420df4711f1aa78))
* **soul:** add semantic graph and reference validation ([#216](https://github.com/TulipFarm/tulipfarm/issues/216)) ([e8b4607](https://github.com/TulipFarm/tulipfarm/commit/e8b4607c5807c8c5fddb4a4fe571443cf677ad80))
* **soul:** atomic signed git changeset writer ([#217](https://github.com/TulipFarm/tulipfarm/issues/217)) ([9e1fcf3](https://github.com/TulipFarm/tulipfarm/commit/9e1fcf373f8b03bd3f999d2e83620d6c5b4f873c))
* **soul:** compile signed immutable execution bundles ([#218](https://github.com/TulipFarm/tulipfarm/issues/218)) ([6610d81](https://github.com/TulipFarm/tulipfarm/commit/6610d815a88d4faf625e75fc0498b4719e7e23ba))
* **soul:** convert legacy Agent/Skill definitions to validated proposals ([#220](https://github.com/TulipFarm/tulipfarm/issues/220)) ([c3d0606](https://github.com/TulipFarm/tulipfarm/commit/c3d0606ab9cda34ad0a5fa0e4e78ce95458e446a))
* **soul:** project and reconcile published Soul versions ([#219](https://github.com/TulipFarm/tulipfarm/issues/219)) ([13ced49](https://github.com/TulipFarm/tulipfarm/commit/13ced4992d4a6abc505f9b9e5002b00d2c716aab))
* **surface:** add Tulip Surface Protocol ([#265](https://github.com/TulipFarm/tulipfarm/issues/265)) ([f85ad39](https://github.com/TulipFarm/tulipfarm/commit/f85ad39ba2ea5e66061a2e299836f3f75bd4a8fc))
* **tool-broker:** add effect ledger and dispatch controls ([#240](https://github.com/TulipFarm/tulipfarm/issues/240)) ([798d825](https://github.com/TulipFarm/tulipfarm/commit/798d82598e4816c9a804ff0bde4bd082a6b5b9de))
* **web:** show real app version in sidebar footer ([#167](https://github.com/TulipFarm/tulipfarm/issues/167)) ([29e0795](https://github.com/TulipFarm/tulipfarm/commit/29e07955a2057598a342339a4cdd56cc5b501029))

### Bug Fixes

* **chat:** enforce owner-only access on conversation read routes ([#187](https://github.com/TulipFarm/tulipfarm/issues/187)) ([433e944](https://github.com/TulipFarm/tulipfarm/commit/433e944e20d71755bed453f935c92e5328bd5fa4))
* **chat:** reject duplicate A2UI turns while a chat turn is in flight ([#185](https://github.com/TulipFarm/tulipfarm/issues/185)) ([d70f38c](https://github.com/TulipFarm/tulipfarm/commit/d70f38cb729d55b05d0207b6eed9851e0ffa2b93))
* **cutover:** make review fail honest ([#257](https://github.com/TulipFarm/tulipfarm/issues/257)) ([f858075](https://github.com/TulipFarm/tulipfarm/commit/f8580756abf22bb1ef11792c2c87cebfc5fa2745))
* **docs:** document the LLM model picker's live suggestions and cost badges ([#192](https://github.com/TulipFarm/tulipfarm/issues/192)) ([d117dc4](https://github.com/TulipFarm/tulipfarm/commit/d117dc4cc86e3bc7ff1f0bd53608ffc73cec174b))
* **governance:** close governance gaps ([#226](https://github.com/TulipFarm/tulipfarm/issues/226)) ([82bcd9e](https://github.com/TulipFarm/tulipfarm/commit/82bcd9eed418f4dda4aa79da44b71d0fe04f8b5e))
* **governance:** harden architecture invariants ([#236](https://github.com/TulipFarm/tulipfarm/issues/236)) ([3b00961](https://github.com/TulipFarm/tulipfarm/commit/3b009612050178cc7a66e72be547deae27bd41ce))
* **integrations:** merge connect body env instead of replacing stored env ([#178](https://github.com/TulipFarm/tulipfarm/issues/178)) ([65b0c3c](https://github.com/TulipFarm/tulipfarm/commit/65b0c3c76184683be05b6147b2042f81db41bf48))
* **integrations:** rate-limit mutating integration routes, annotate clone safety ([#190](https://github.com/TulipFarm/tulipfarm/issues/190)) ([b896a87](https://github.com/TulipFarm/tulipfarm/commit/b896a8772f0a661f02bdd8582688e9f0f2f82ef2))
* **integrations:** require admin role for integration lifecycle routes ([#198](https://github.com/TulipFarm/tulipfarm/issues/198)) ([88f2a84](https://github.com/TulipFarm/tulipfarm/commit/88f2a848a3f2911cb3f1f610e3fb19dbb0cde77c)), closes [#173](https://github.com/TulipFarm/tulipfarm/issues/173)
* **integrations:** seal secret env values into the secrets store, not connection.yaml ([#161](https://github.com/TulipFarm/tulipfarm/issues/161)) ([7068dc9](https://github.com/TulipFarm/tulipfarm/commit/7068dc9ce60c21bb913b74dad20134fcf88557ec))
* **knowledge:** make reindex replacement atomic ([#196](https://github.com/TulipFarm/tulipfarm/issues/196)) ([461bbc7](https://github.com/TulipFarm/tulipfarm/commit/461bbc787a533f2affac4c500832de5c3e062f7d))
* **routines:** sharpen routine_forge tool description with schema essentials ([#191](https://github.com/TulipFarm/tulipfarm/issues/191)) ([b8d4d01](https://github.com/TulipFarm/tulipfarm/commit/b8d4d01641c7a094b05859709efc9853afa85295))
* **schema:** close contract gaps ([#214](https://github.com/TulipFarm/tulipfarm/issues/214)) ([8ffda40](https://github.com/TulipFarm/tulipfarm/commit/8ffda407061bc37f55d8c574897176995d1a9d90))
* **schema:** register draft-06/07 meta-schemas for MCP tool schemas ([#165](https://github.com/TulipFarm/tulipfarm/issues/165)) ([dd98004](https://github.com/TulipFarm/tulipfarm/commit/dd98004153520654debe49bb2f0cd45e8f959ee2)), closes [#163](https://github.com/TulipFarm/tulipfarm/issues/163)
* **setup:** close the first-admin check-then-insert race with a DB invariant ([#188](https://github.com/TulipFarm/tulipfarm/issues/188)) ([b995190](https://github.com/TulipFarm/tulipfarm/commit/b995190277338c9ff6d6f7b95d4aad616cec1a90))
* **web:** render routine run-detail as a sibling route, not a nested one ([#170](https://github.com/TulipFarm/tulipfarm/issues/170)) ([985e198](https://github.com/TulipFarm/tulipfarm/commit/985e198a3f10202a92ac1394fbaab088e8e9b601))
* **web:** show not-found state for a missing integration, not a connectivity error ([#171](https://github.com/TulipFarm/tulipfarm/issues/171)) ([78ea84b](https://github.com/TulipFarm/tulipfarm/commit/78ea84b4cf68b5f48d38430a77e856ad964e4b48))

## [0.3.0-integrations.1](https://github.com/TulipFarm/tulipfarm/compare/v0.3.0-integrations.0...v0.3.0-integrations.1) (2026-07-16)

### Features

* **routines:** forge skill + activities tab + correct record_* tool names ([#157](https://github.com/TulipFarm/tulipfarm/issues/157)) ([aca1f87](https://github.com/TulipFarm/tulipfarm/commit/aca1f8715c3a8cb346f560f085470a7e6ef39b2d))

### Bug Fixes

* **hooks:** bundle hook-worker.cjs so the prod image can spawn the sandbox worker ([7d3d41b](https://github.com/TulipFarm/tulipfarm/commit/7d3d41bcc3ca79394f07ad8c461a1c94ee93e2d6))

## [0.3.0-integrations.0](https://github.com/TulipFarm/tulipfarm/compare/v0.2.1...v0.3.0-integrations.0) (2026-07-14)

### Features

* **ingress:** header context + header dedup — enables github-style providers ([2f48379](https://github.com/TulipFarm/tulipfarm/commit/2f48379ed8745d406ae8692d2ae393b4b1e2f593))
* **ingress:** slack ingress, integration update restart, app update notice ([c6c8bbe](https://github.com/TulipFarm/tulipfarm/commit/c6c8bbe143d026800e1b2e6e6e142746086d105a)), closes [#branch](https://github.com/TulipFarm/tulipfarm/issues/branch)

## [0.2.1](https://github.com/TulipFarm/tulipfarm/compare/v0.2.0...v0.2.1) (2026-07-13)

### Bug Fixes

* **tools:** remove regex lookaround from navigate_to input schema ([2438cde](https://github.com/TulipFarm/tulipfarm/commit/2438cde267cedc2d10644a1a62ce8484a816ed8d))
* **web:** skip soul backup setup step when git remote is env-configured ([4002110](https://github.com/TulipFarm/tulipfarm/commit/40021100c8297fadc20f26fbe22ab2a584f07d3b))

## [0.2.0](https://github.com/TulipFarm/tulipfarm/compare/v0.1.1...v0.2.0) (2026-07-13)

### Features

* **memory:** apply preference-typed memory entries actively ([#150](https://github.com/TulipFarm/tulipfarm/issues/150)) ([c5e350e](https://github.com/TulipFarm/tulipfarm/commit/c5e350ee9e14071a3ae85ce151f6467d6cdbbcd2))
* **onboarding:** personalize checklist & suggestions from business context via LLM ([#152](https://github.com/TulipFarm/tulipfarm/issues/152)) ([89a5bd7](https://github.com/TulipFarm/tulipfarm/commit/89a5bd77e2fdf6dd2a98c44026742b0e9bd29fd0)), closes [#130](https://github.com/TulipFarm/tulipfarm/issues/130)

### Bug Fixes

* **docker:** install ca-certificates in runtime image ([ed5c22b](https://github.com/TulipFarm/tulipfarm/commit/ed5c22bff24473c8e1eb14507b68205061ed71c7))

## [0.1.1](https://github.com/TulipFarm/tulipfarm/compare/v0.1.0...v0.1.1) (2026-07-09)

### Bug Fixes

* **release:** derive github.com URLs instead of the SSH remote alias ([edee119](https://github.com/TulipFarm/tulipfarm/commit/edee119f4afeeba1778cb147a2f2abbbc53b5ddf))

## 0.1.0 (2026-07-09)

### Features

* @tulipfarm/llm — Vercel AI SDK adapter with fallback chains (closes [#32](https://github.com/TulipFarm/tulipfarm/issues/32)) ([4af9a11](https://github.com/TulipFarm/tulipfarm/commit/4af9a110624acb41d3687158fec22270cc637d23))
* @tulipfarm/validation — AJV + TypeBox stack (closes [#24](https://github.com/TulipFarm/tulipfarm/issues/24)) ([4576aea](https://github.com/TulipFarm/tulipfarm/commit/4576aea32dfa0baee0b1f3629c9bcb7d60b6423a))
* **surface:** declarative surfaces, HITL, live updates, and frontend tools ([#50](https://github.com/TulipFarm/tulipfarm/issues/50)) ([d53959e](https://github.com/TulipFarm/tulipfarm/commit/d53959efe43be7dd58b411a03ab2ba4b4baf069c))
* **surface:** native Surface interactions (TSP-V1-001/002) ([#41](https://github.com/TulipFarm/tulipfarm/issues/41)) ([d7f1c10](https://github.com/TulipFarm/tulipfarm/commit/d7f1c109547f7d67d04f56830eca21db0f2c4453))
* **surface:** native Chart component via inlined Chart.js, CSP-safe (AC-V1-003) ([#42](https://github.com/TulipFarm/tulipfarm/issues/42)) ([c2c72d6](https://github.com/TulipFarm/tulipfarm/commit/c2c72d6bee6f9b150a447f83533c6df059b2a780))
* **surface:** RecordTable rendering + schema-driven shell list sort/filter/pagination ([#39](https://github.com/TulipFarm/tulipfarm/issues/39)) ([244ce97](https://github.com/TulipFarm/tulipfarm/commit/244ce97d8f88897da587d9730cbbdd7ecfa3476f))
* **surface:** typed Form rendering, display-only (TSP-V1-002) ([#40](https://github.com/TulipFarm/tulipfarm/issues/40)) ([f28d08a](https://github.com/TulipFarm/tulipfarm/commit/f28d08ace5a6ccdc0d58537aeed887eca496f9e3))
* **surface:** TSP semantic component catalog (TSP-V1-002) ([#37](https://github.com/TulipFarm/tulipfarm/issues/37)) ([1361a07](https://github.com/TulipFarm/tulipfarm/commit/1361a0797fecefd75fd8c73a0bc12654039e97f0))
* activities page ([#111](https://github.com/TulipFarm/tulipfarm/issues/111)) ([6d70ecf](https://github.com/TulipFarm/tulipfarm/commit/6d70ecf6108714748013a1e91ee37162058904dd))
* add security and encryption ([#64](https://github.com/TulipFarm/tulipfarm/issues/64)) ([cc53931](https://github.com/TulipFarm/tulipfarm/commit/cc5393102d0a1ab38e55f5d7528fb551330a92d6))
* admin-only secrets API (closes [#17](https://github.com/TulipFarm/tulipfarm/issues/17)) ([e5a85fe](https://github.com/TulipFarm/tulipfarm/commit/e5a85feba21c106817f008447648ede4dd13689e))
* AES-256-GCM secret storage in MongoDB (closes [#14](https://github.com/TulipFarm/tulipfarm/issues/14)) ([5bc70da](https://github.com/TulipFarm/tulipfarm/commit/5bc70da84c1460c63cc21136a499dd58f4b6a5dd))
* **agents,skills:** Agents UI + Skills UI with real SkillAudit install flow (UI-V1-003 / SKL-V1-002·003) ([db3e37c](https://github.com/TulipFarm/tulipfarm/commit/db3e37cd3c0484fbde888feba9e6dca8a560c830))
* **agents:** built-in GeneralAssistant + agent registry, per-turn resolution (AGT-V1-007) ([e581f1d](https://github.com/TulipFarm/tulipfarm/commit/e581f1d19f0d7d2b315d7be8c45518d69b428318))
* **agents:** write-time frontmatter meta-schema gate for agent_create/update (AGT-V1-005 / VAL-V1-010) ([9b2da87](https://github.com/TulipFarm/tulipfarm/commit/9b2da879f1283ad05ba5ea5b92c1cf27238f1d49))
* **approvals:** app-wide approvals surface — list page + live sidebar badge ([c7e0a50](https://github.com/TulipFarm/tulipfarm/commit/c7e0a505634a87a3b348996336d6363c57e87403))
* **approvals:** standalone /api/v1/approvals routes + DB table (AGT-V1-002) ([#36](https://github.com/TulipFarm/tulipfarm/issues/36)) ([2faa911](https://github.com/TulipFarm/tulipfarm/commit/2faa91117eb442dc1eea6b13348a3e0f0a83426a))
* basic CI pipeline with Biome lint, typecheck, and unit tests (closes [#5](https://github.com/TulipFarm/tulipfarm/issues/5)) ([f737e9f](https://github.com/TulipFarm/tulipfarm/commit/f737e9f4fa4a338b555013affec8842774f8b5f4))
* bearer API token auth (closes [#8](https://github.com/TulipFarm/tulipfarm/issues/8)) ([effc04d](https://github.com/TulipFarm/tulipfarm/commit/effc04d06d7c90d6ff147574f573106064e2d207))
* BullMQ repeatable down-sync every 5 min + push retry (closes [#19](https://github.com/TulipFarm/tulipfarm/issues/19)) ([7749ec8](https://github.com/TulipFarm/tulipfarm/commit/7749ec89f607318d0d8aee0d50e9238ca7276367))
* **chat+feedback:** Tiptap mentions, message feedback, chats browse, provenance ([#48](https://github.com/TulipFarm/tulipfarm/issues/48)) ([81566e9](https://github.com/TulipFarm/tulipfarm/commit/81566e9dad90a128f7936b60c3fa0beb456b302b))
* **chat:** agent [@mention](https://github.com/mention) routing, agent glyphs, mention chips, and stream stop ([#57](https://github.com/TulipFarm/tulipfarm/issues/57)) ([59344ec](https://github.com/TulipFarm/tulipfarm/commit/59344ec58753307ab6baa8a2fd919fbd4eac7b58))
* **chat:** dev-only debug drawer exposing raw conversation state + system prompt ([#58](https://github.com/TulipFarm/tulipfarm/issues/58)) ([5128d4d](https://github.com/TulipFarm/tulipfarm/commit/5128d4de3d933346011094a56f8c75c2f8c09dad))
* **chat:** durable conversation message store + paginated read API (CTX-V1-002) ([9406b86](https://github.com/TulipFarm/tulipfarm/commit/9406b86fc3782fe82613d63ca2c4d3b0b0112257))
* **chat:** durable SSE resume — stream_resume buffer + StreamHub + Last-Event-ID replay (DB-V1) ([f971bf8](https://github.com/TulipFarm/tulipfarm/commit/f971bf8ad4d09fb9f8c49f85258714da824511f9))
* **chat:** live chat shell — streaming UI, SSE backend, tool approvals ([#137](https://github.com/TulipFarm/tulipfarm/issues/137)) ([4c7316e](https://github.com/TulipFarm/tulipfarm/commit/4c7316e82957daba49e49b8370a3eb62640350ab))
* **chat:** persist, title, and browse chats + sidebar/model polish ([#47](https://github.com/TulipFarm/tulipfarm/issues/47)) ([2f41fd5](https://github.com/TulipFarm/tulipfarm/commit/2f41fd560c6ad1392e59fa03b0e917cbba66e12d))
* **chat:** POST /api/v1/chat streaming turn with per-turn model override (AC-V1-001) ([c77c577](https://github.com/TulipFarm/tulipfarm/commit/c77c577de5c8271706dcdca856c5a455aa58ab8f))
* **chat:** remove edit user message functionality ([#89](https://github.com/TulipFarm/tulipfarm/issues/89)) ([581457d](https://github.com/TulipFarm/tulipfarm/commit/581457db5627b184e55beeefac51fad2be19fd60))
* **chat:** summarize-oldest conversation compaction (CTX-V1-001/002) ([#45](https://github.com/TulipFarm/tulipfarm/issues/45)) ([1faa552](https://github.com/TulipFarm/tulipfarm/commit/1faa552ca227e052ec0d7eb4d8d53a0f487f9596))
* **ci:** daily automated documentation update workflow ([#74](https://github.com/TulipFarm/tulipfarm/issues/74)) ([352e3fb](https://github.com/TulipFarm/tulipfarm/commit/352e3fbafd6d343c799d82dcec1ff7f1cb030eb8))
* **ci:** scheduled GitHub Actions workflows for absolute-* skills ([#82](https://github.com/TulipFarm/tulipfarm/issues/82)) ([412dfcd](https://github.com/TulipFarm/tulipfarm/commit/412dfcd8b09b7d8be9fbd75d3a3a62a2e944c047))
* **context:** deterministic assembleSystemPrompt — 9-block system prompt from durable stores (CTX-V1) ([dfc43ec](https://github.com/TulipFarm/tulipfarm/commit/dfc43ec0fe599d28203333845bdfed7a113cb43e))
* **context:** fill <soul-context> + <available-tools> prompt blocks ([#59](https://github.com/TulipFarm/tulipfarm/issues/59)) ([f9d7933](https://github.com/TulipFarm/tulipfarm/commit/f9d79336f909e2f21e319ee560f28524fe7455c8))
* **context:** inject business context from soul.yaml into system prompt ([#131](https://github.com/TulipFarm/tulipfarm/issues/131)) ([5c1aa92](https://github.com/TulipFarm/tulipfarm/commit/5c1aa92c0c7f199a4a17a59c179c0be5d6bf2a33)), closes [TulipFarm/tulipfarm#120](https://github.com/TulipFarm/tulipfarm/issues/120)
* CSRF double-submit cookie protection (closes [#9](https://github.com/TulipFarm/tulipfarm/issues/9)) ([e7897d0](https://github.com/TulipFarm/tulipfarm/commit/e7897d05b338439332afb044a6274fa3e16ea527))
* cursor pagination utility (closes [#11](https://github.com/TulipFarm/tulipfarm/issues/11)) ([ad87720](https://github.com/TulipFarm/tulipfarm/commit/ad877202e9fba1291356eec641b5111aaf58d261))
* **db:** migrate datastore from MongoDB+Redis to Postgres-only (DB-V1-001) ([a765452](https://github.com/TulipFarm/tulipfarm/commit/a7654524c534649fc7019b3847d8249e16caff91))
* **deploy:** multi-arch image, compose stack, CI parity + release tooling ([d4d658f](https://github.com/TulipFarm/tulipfarm/commit/d4d658f0380df0cbc48850561d8dfb097dbe9a94))
* **docs:** documentation site with terminal-native landing page (DOC-V1-001) ([0967061](https://github.com/TulipFarm/tulipfarm/commit/09670618853e58c9e78487fe0cf13d226315fdec))
* dual-key graceful decryption + ENCRYPTION_KEY_PREVIOUS validation (closes [#16](https://github.com/TulipFarm/tulipfarm/issues/16)) ([0eeaa6c](https://github.com/TulipFarm/tulipfarm/commit/0eeaa6c5430ee22aba9195ea279bcbb9484b7588)), closes [#17](https://github.com/TulipFarm/tulipfarm/issues/17)
* Fastify server setup with CORS, helmet, and port 4010 (closes [#6](https://github.com/TulipFarm/tulipfarm/issues/6)) ([454c82a](https://github.com/TulipFarm/tulipfarm/commit/454c82aa7a9cb71e3e26d57ff3d2297b416edb02))
* **forge:** inbuilt General Assistant + Information Architect agents ([#46](https://github.com/TulipFarm/tulipfarm/issues/46)) ([75de67a](https://github.com/TulipFarm/tulipfarm/commit/75de67aaf28b5ff2171f14deb5b1e3d16546927c))
* **guardrails:** 3-stage guard framework with three V1 pattern guards ([#34](https://github.com/TulipFarm/tulipfarm/issues/34)) ([020689b](https://github.com/TulipFarm/tulipfarm/commit/020689b2213871213ef2c61929a3bbee69ffdefc))
* hook safety layers — L2 determinism, L3 static analysis, L5 operational controls ([b2e0c6f](https://github.com/TulipFarm/tulipfarm/commit/b2e0c6fe2105d9574920286e265f8cc232d58fb9))
* **hooks:** add hook authoring tools and delete hook support ([7580b90](https://github.com/TulipFarm/tulipfarm/commit/7580b909f03343c32cd54c578ec7947e261174e3))
* **install:** one-line curl|bash OCI installer with docs ([#186](https://github.com/TulipFarm/tulipfarm/issues/186)) ([c6fa816](https://github.com/TulipFarm/tulipfarm/commit/c6fa8164514d2bc627942eb7892d6efca79626c6))
* **integrations:** manifest v2 — egress/ingress types, slug-keyed instances ([18a5a0a](https://github.com/TulipFarm/tulipfarm/commit/18a5a0ae53d25ba78235de101abd03d3eb170d33)), closes [#95](https://github.com/TulipFarm/tulipfarm/issues/95)
* **knowledge:** agent hybrid search + page citations ([#107](https://github.com/TulipFarm/tulipfarm/issues/107)) ([642db52](https://github.com/TulipFarm/tulipfarm/commit/642db524de72e52276366c619a6d3836c215fcf3))
* **knowledge:** chunk-hash dedup + reindex/backfill/index-status + connector framework ([#105](https://github.com/TulipFarm/tulipfarm/issues/105)) ([2b021da](https://github.com/TulipFarm/tulipfarm/commit/2b021daba239e547c0b43ed06a326765a3f739c6))
* **knowledge:** human page-level lexical search — ⌘K palette, prefix FTS, facets, pg_trgm ([#99](https://github.com/TulipFarm/tulipfarm/issues/99)) ([a857487](https://github.com/TulipFarm/tulipfarm/commit/a85748748fb6e5d4877919edbb9968f92b593cfe))
* **knowledge:** knowledge search in chat — tools, auto-grounding, citations ([#96](https://github.com/TulipFarm/tulipfarm/issues/96)) ([696e5dd](https://github.com/TulipFarm/tulipfarm/commit/696e5dd7de35cdcecb31b87801e37aab0fef43ff))
* **knowledge:** OKF wiki — UUID concept permalinks, history drawer ([#67](https://github.com/TulipFarm/tulipfarm/issues/67)) ([3770ceb](https://github.com/TulipFarm/tulipfarm/commit/3770ceb100b6b627da6233a4b9612ae250db98fe))
* **knowledge:** web management UI + derived indexingStatus (UI-V1-003) ([#44](https://github.com/TulipFarm/tulipfarm/issues/44)) ([1b34b36](https://github.com/TulipFarm/tulipfarm/commit/1b34b36da9ff80aefb75bed4edaa53acb4f71e6a))
* **kv:** generic scoped key-value store (system/user/agent, jsonb, l… ([#62](https://github.com/TulipFarm/tulipfarm/issues/62)) ([1b71549](https://github.com/TulipFarm/tulipfarm/commit/1b715494e65dae7359294714a1eb09311244f157))
* **llm:** auto tier resolution — resolveTier rules + LlmService.select ([b0e11f7](https://github.com/TulipFarm/tulipfarm/commit/b0e11f7019ba1cf71ffe651dcacd1ad291ca467c))
* **llm:** embeddings provider config + priority resolution (LLM-V1-004) ([58e7d24](https://github.com/TulipFarm/tulipfarm/commit/58e7d24343522df03eb852652a3e27a60db32c00))
* **llm:** FallbackProvider hard/transient error classification + Pino fallback logging (AC-V1-002) ([bc27722](https://github.com/TulipFarm/tulipfarm/commit/bc277220109007f1cde445274285f936d8598e16))
* **llm:** surface SecretUnavailableError as clear LlmCredentialError (AC-V1-003) ([7ef23b5](https://github.com/TulipFarm/tulipfarm/commit/7ef23b5ed68e0e5adcb1dab3b9bcb04b6e8d06e0))
* **llm:** validate model id format + hot-reload llm.config on soul.synced (LLM-V1-003) ([d964f4c](https://github.com/TulipFarm/tulipfarm/commit/d964f4c8cc256808e59575c8f6a18bc40ce06e14))
* **memory:** add Settings → Memory page for user-managed memory & preferences ([#113](https://github.com/TulipFarm/tulipfarm/issues/113)) ([cb0bcdb](https://github.com/TulipFarm/tulipfarm/commit/cb0bcdb27830d1483d0c161e5f28e8a37dd5a906))
* **memory:** per-user working memory store + update_memory/delete_memory tools wired into chat (MEM-V1-004) ([4c56dd6](https://github.com/TulipFarm/tulipfarm/commit/4c56dd622afaa72c112594e49d2cb3c75d871e8b))
* migration-on-boot framework (closes [#4](https://github.com/TulipFarm/tulipfarm/issues/4)) ([db1723e](https://github.com/TulipFarm/tulipfarm/commit/db1723e7e05929f3c96e792c21146516c2a76f76))
* **observability:** observability dashboard, Grafana/OTLP export, LiteLLM model-spec pricing ([#114](https://github.com/TulipFarm/tulipfarm/issues/114)) ([f63ef28](https://github.com/TulipFarm/tulipfarm/commit/f63ef28a65e08bd1cfa520f05c0a7042f4a2ef14))
* **onboarding:** adaptive soul-derived suggestion chips over chat (ONB-V1-001/002/003) ([#43](https://github.com/TulipFarm/tulipfarm/issues/43)) ([3e81779](https://github.com/TulipFarm/tulipfarm/commit/3e8177990f3a8a180682e55986540d8899618fb5))
* **onboarding:** getting-started checklist + contextual recommender ([#115](https://github.com/TulipFarm/tulipfarm/issues/115)) ([23d2c93](https://github.com/TulipFarm/tulipfarm/commit/23d2c93c227a867a787e972f3488261cd8928575))
* **onboarding:** setup wizard with auto-detect, all-provider LLM step, headless seeding docs ([7178c4f](https://github.com/TulipFarm/tulipfarm/commit/7178c4f964f06786955ed52d5fd4ef693d2de8b0))
* OpenAPI 3.1 + Scalar UI (closes [#12](https://github.com/TulipFarm/tulipfarm/issues/12)) ([5efe32c](https://github.com/TulipFarm/tulipfarm/commit/5efe32c3c9d6047f4cba9f035450d8a8e0c3221f))
* rate limiting — sliding window per IP for auth endpoints (closes [#10](https://github.com/TulipFarm/tulipfarm/issues/10)) ([9e03c88](https://github.com/TulipFarm/tulipfarm/commit/9e03c88837f912c38801dae68a1efdafd02470ce))
* resource data CRUD — POST/GET/PUT/PATCH/DELETE with UUID id, If-Match concurrency, soft delete, history (closes [#29](https://github.com/TulipFarm/tulipfarm/issues/29)) ([10d3639](https://github.com/TulipFarm/tulipfarm/commit/10d3639aea1c9be7a772b55ede9d99de67aaafdb))
* resource type CRUD — POST/GET /api/v1/resource-types, YAML in/out, AJV meta-schema + x-* whitelist validation (closes [#28](https://github.com/TulipFarm/tulipfarm/issues/28)) ([48dd6d2](https://github.com/TulipFarm/tulipfarm/commit/48dd6d27114fe2e00bba4d677bb9f0188064cbd0))
* **routines:** v1 routine engine — parser, state machine, scheduler, approvals, SSE, forge, UI ([169a2ed](https://github.com/TulipFarm/tulipfarm/commit/169a2ed45c5ac48529f74320d5d4402d064a0d2e))
* session auth (tf_sid cookie, Argon2id, Redis sessions) (closes [#7](https://github.com/TulipFarm/tulipfarm/issues/7)) ([05b2d63](https://github.com/TulipFarm/tulipfarm/commit/05b2d6309b472d9fca9fa39e75c9d082d4cef902))
* **settings:** add read-only soul explorer with file tree + syntax highlighting ([#112](https://github.com/TulipFarm/tulipfarm/issues/112)) ([fc526ea](https://github.com/TulipFarm/tulipfarm/commit/fc526ead8a359e5b56c07c0970d11f11e6a96a66))
* **settings:** provider-registry Settings — secrets + LLM config, Azure chat ([f5672f9](https://github.com/TulipFarm/tulipfarm/commit/f5672f939564261157791befcfaa50c7ea2bf392))
* **settings:** rename Azure provider to Azure Foundry + rework LLM model picker and secrets edit ([#117](https://github.com/TulipFarm/tulipfarm/issues/117)) ([2c4c335](https://github.com/TulipFarm/tulipfarm/commit/2c4c335c3340b1b5e75bf67154ce599820601ac4))
* **settings:** rework into section-sidebar shell with per-section UX ([#116](https://github.com/TulipFarm/tulipfarm/issues/116)) ([7f3e5a7](https://github.com/TulipFarm/tulipfarm/commit/7f3e5a7a368ccd9f44727fda2b8bc1705099a0df))
* **skills:** implement eager <skills> block in system-prompt assembly ([#32](https://github.com/TulipFarm/tulipfarm/issues/32)) ([76d707e](https://github.com/TulipFarm/tulipfarm/commit/76d707edd64dc38eabf5fae45edab2d66ebb8ff0))
* **skills:** Installed + Marketplace tabs with version-diff and clear audit errors ([#35](https://github.com/TulipFarm/tulipfarm/issues/35)) ([3447227](https://github.com/TulipFarm/tulipfarm/commit/3447227ef41528871f985331dc66e55d4683b50b))
* **skills:** render <available-skills> from SkillRegistry (all-lazy V1) ([#19](https://github.com/TulipFarm/tulipfarm/issues/19)) ([2a70fbb](https://github.com/TulipFarm/tulipfarm/commit/2a70fbbceee7a9761344c89c1e3a0278d0a647d9))
* **skills:** skill-forge triggers SkillAudit before activation (AC-V1-002) ([#38](https://github.com/TulipFarm/tulipfarm/issues/38)) ([30bab9a](https://github.com/TulipFarm/tulipfarm/commit/30bab9a77292e09c14a0b69bfbfe06a0f9d30c58))
* soul format migrations on boot (closes [#22](https://github.com/TulipFarm/tulipfarm/issues/22)) ([de9abc5](https://github.com/TulipFarm/tulipfarm/commit/de9abc56d9949073bd0899751fed57592b1c861b))
* soul git sync on boot + extract packages/soul and packages/secrets ([acc712d](https://github.com/TulipFarm/tulipfarm/commit/acc712de3dfee33b5fdad28813dce3f76a6933e1)), closes [#18](https://github.com/TulipFarm/tulipfarm/issues/18)
* soul_repo_commit + soul_repo_push tools + constants package (closes [#20](https://github.com/TulipFarm/tulipfarm/issues/20)) ([d9755d9](https://github.com/TulipFarm/tulipfarm/commit/d9755d92197b1f7a98b75422b51c6d22f2767bee))
* **soul:** consolidate llm.config.yaml into soul.yaml[#llm](https://github.com/TulipFarm/tulipfarm/issues/llm) ([#124](https://github.com/TulipFarm/tulipfarm/issues/124)) ([c827467](https://github.com/TulipFarm/tulipfarm/commit/c8274677ec65c87973c1a008b41ffce42c1992d2)), closes [#119](https://github.com/TulipFarm/tulipfarm/issues/119)
* **soul:** git-sync robustness, sync status UI, clearer error UX ([#121](https://github.com/TulipFarm/tulipfarm/issues/121)) ([5e8ab06](https://github.com/TulipFarm/tulipfarm/commit/5e8ab06aca117e263c3ccd6aea83ae4d3ed06a3e))
* SoulLoader — parse all soul artifact types (closes [#21](https://github.com/TulipFarm/tulipfarm/issues/21)) ([f0fe95d](https://github.com/TulipFarm/tulipfarm/commit/f0fe95d2f562fee8c1fb5e6fca9c736dbae8bb48))
* **tools:** cap large results in LLM context, full result in SSE UI event (TOOL-V1-010) ([98e8c37](https://github.com/TulipFarm/tulipfarm/commit/98e8c371ea2c9c5caadc7c2315129a3e7ff3ab42))
* **tools:** central ToolRegistry + execution contract (TOOL-V1) ([a31c20d](https://github.com/TulipFarm/tulipfarm/commit/a31c20d5d1797a19480cdb65e592ab405df4e531))
* **tools:** create/list/schema/update resource-type tools + GitSyncService.withSync (TOOL-V1) ([1addc67](https://github.com/TulipFarm/tulipfarm/commit/1addc67e5ecb595d3f479d6222c67869fe56e628))
* **tools:** parallel reads, sequential writes per batch (TOOL-V1-008) ([f269d7c](https://github.com/TulipFarm/tulipfarm/commit/f269d7cf681c07b48580f84d289b0f4ae4547439))
* **tools:** platform tools — load_skill/reference, present, request_input, present, validate_artifact, transfer/delegate_to_agent (TOOL-V1) ([8183b03](https://github.com/TulipFarm/tulipfarm/commit/8183b038cfc3ab326474bc1c9603405567ac38ab))
* **tools:** resource_create/list/get/update/delete/search system tools (TOOL-V1) ([46b8f6f](https://github.com/TulipFarm/tulipfarm/commit/46b8f6f79550f14d3041206071666b7b20b70e4a))
* **tools:** soul + routine platform tools — trigger_routine, routine_picker, begin/end_soul_batch, soul_repo_commit/push, call_skill, complete_state (TOOL-V1-005) ([e5bd3d9](https://github.com/TulipFarm/tulipfarm/commit/e5bd3d9473242bfff6705670eefb4abbe75c8b82))
* **tools:** soul CRUD tools — agent_* and skill_* (TOOL-V1-005) ([2e0e98b](https://github.com/TulipFarm/tulipfarm/commit/2e0e98b77353183d8b165a4a53b1f9459547cdca))
* **tools:** validate tool args at registry level, return validation_error result (TOOL-V1-009) ([d4fbf01](https://github.com/TulipFarm/tulipfarm/commit/d4fbf01912e6124e1af0ee8d48643d5c6b79e1dd))
* **ui:** add Modal component and confirm delete for secrets ([#54](https://github.com/TulipFarm/tulipfarm/issues/54)) ([349bb76](https://github.com/TulipFarm/tulipfarm/commit/349bb76f459677a5ffc4f0dc1539b2ab73587288))
* validate all required env vars at API startup (closes [#13](https://github.com/TulipFarm/tulipfarm/issues/13)) ([7307b70](https://github.com/TulipFarm/tulipfarm/commit/7307b7058e953ecf9ba85b7a53477dcf2fa950fc))
* **web:** Tulip Surface Protocol security/rendering foundation — native component renderer (TSP-V1-004) ([15baa1f](https://github.com/TulipFarm/tulipfarm/commit/15baa1fc4b06fc988abebd83fcf4096529248071))
* **web:** add PWA favicon + manifest, fix railed sidebar footer stacking ([#100](https://github.com/TulipFarm/tulipfarm/issues/100)) ([6618011](https://github.com/TulipFarm/tulipfarm/commit/6618011fa85cddc90f198f582b17255658c47719))
* **web:** frontend shell scaffold + UI craft pass (ruby terminal design system) ([bdb8b53](https://github.com/TulipFarm/tulipfarm/commit/bdb8b533c8182622bb871da3e538fb52a675bd18))
* **web:** schema-driven create + edit forms per resource type (UI-V1-002 write / AC-V1-002) ([a58c2ed](https://github.com/TulipFarm/tulipfarm/commit/a58c2edf4e47a17c8023c0eaa65883de999d87df))
* **web:** schema-driven Resources read-only list + detail (UI-V1-002) ([5a500cf](https://github.com/TulipFarm/tulipfarm/commit/5a500cff33909edadbad39871054142ca42e029e))
* wire pnpm dev with Turborepo watch for concurrent api+web dev ([f2890fe](https://github.com/TulipFarm/tulipfarm/commit/f2890fef49f9e9639086a24b3c825f4b3ab7f24c)), closes [#3](https://github.com/TulipFarm/tulipfarm/issues/3)
* x-links validate-on-write + orphan-on-delete (closes [#30](https://github.com/TulipFarm/tulipfarm/issues/30)) ([0a355fc](https://github.com/TulipFarm/tulipfarm/commit/0a355fc1c1aeaaf760fd04c8c8281eb8d66fa6b4))

### Bug Fixes

* **surface:** resolve dataModel bindings for DataTable, List, DetailView array props ([#134](https://github.com/TulipFarm/tulipfarm/issues/134)) ([723e823](https://github.com/TulipFarm/tulipfarm/commit/723e823187f86a56a96cf0f7f2b65c3915f66e50)), closes [#133](https://github.com/TulipFarm/tulipfarm/issues/133)
* **auth:** default ADMIN_EMAIL to a valid email ([4633719](https://github.com/TulipFarm/tulipfarm/commit/4633719a7d92856ffe012f2472b435187bd1c800))
* **chat:** enforce request_input for branching decisions ([698118e](https://github.com/TulipFarm/tulipfarm/commit/698118ea60ae96c4d9d861e7e6f22d19974e05d6))
* **ci:** add GitHub MCP tool to docs-update for PR creation ([#80](https://github.com/TulipFarm/tulipfarm/issues/80)) ([28e7b03](https://github.com/TulipFarm/tulipfarm/commit/28e7b037be8470b7f911aa19a4edd16481f7ce67))
* **ci:** allow Bash tool in docs-update workflow ([#77](https://github.com/TulipFarm/tulipfarm/issues/77)) ([8a822d4](https://github.com/TulipFarm/tulipfarm/commit/8a822d47a835cb92b0f3d518685864019f0b900c))
* **ci:** move env out of with block in scheduled workflows ([#97](https://github.com/TulipFarm/tulipfarm/issues/97)) ([da6640c](https://github.com/TulipFarm/tulipfarm/commit/da6640ca36ca1a025d9dfe351f014503a7c7f621))
* **ci:** propagate GH_TOKEN to Claude actions and reschedule to 2 AM IST ([#83](https://github.com/TulipFarm/tulipfarm/issues/83)) ([e922281](https://github.com/TulipFarm/tulipfarm/commit/e9222814e65ff05ca6b76e52fe1fa5706873d109))
* **ci:** use CLAUDE_CODE_OAUTH_TOKEN for claude-code-action auth ([#76](https://github.com/TulipFarm/tulipfarm/issues/76)) ([2b8e777](https://github.com/TulipFarm/tulipfarm/commit/2b8e777a69913c320c27a78f5d2d569999315afa))
* **deploy:** set VITE_API_URL, hash-based CSP, and managed-mode compose env vars ([709d4b3](https://github.com/TulipFarm/tulipfarm/commit/709d4b33d8ef7a5438e54b447130c69493740277))
* **llm:** disable strict tool schemas for openai/azure providers ([7be4bd9](https://github.com/TulipFarm/tulipfarm/commit/7be4bd908800035c9be9550abcd3a9d2a96058ed))
* **llm:** prevent boot crash when provider secrets are deleted ([#53](https://github.com/TulipFarm/tulipfarm/issues/53)) ([ffe78e5](https://github.com/TulipFarm/tulipfarm/commit/ffe78e5354531d5809e99e7f67d88a0cb57ce165))
* remove import of gitignored soul/migrate module ([881efab](https://github.com/TulipFarm/tulipfarm/commit/881efabb6b0e9200a97ee4e07a9cbcec524cca86))
* **security:** add rate limiting to resource-type routes ([090439b](https://github.com/TulipFarm/tulipfarm/commit/090439b7cc44b04199588d95208b7f1890e682b3))
* **setup:** use key-prefixed sed patterns to set distinct env secrets ([#51](https://github.com/TulipFarm/tulipfarm/issues/51)) ([dc0c745](https://github.com/TulipFarm/tulipfarm/commit/dc0c745dd8c4e568b40ccc581659561959730a73))
* **skills:** wire eager <skills> into prompt assembly; harden load_skill_reference vs path traversal ([#33](https://github.com/TulipFarm/tulipfarm/issues/33)) ([9218538](https://github.com/TulipFarm/tulipfarm/commit/9218538783d02413320a42c55328a48fea5498cf))
* **web:** remove hardcoded dev credential prefill from login form ([#126](https://github.com/TulipFarm/tulipfarm/issues/126)) ([2b0ac7d](https://github.com/TulipFarm/tulipfarm/commit/2b0ac7d854bb1430ba74bb1d85cb606526626bb9)), closes [#122](https://github.com/TulipFarm/tulipfarm/issues/122)
* wire hook subsystem; dedupe and harden resource write pipeline ([290eae0](https://github.com/TulipFarm/tulipfarm/commit/290eae015fe41373b181ccd16c02eb1de375e48f))

### Reverts

* Revert "chore: remove dependabot and CI workflows" ([8a259a9](https://github.com/TulipFarm/tulipfarm/commit/8a259a9689fff1a9a035be408b81dc4a98c056c7))

## 0.1.0-build-test.0 (2026-06-19)

### Features

* @tulipfarm/llm — Vercel AI SDK adapter with fallback chains (closes [#32](https://github.com/TulipFarm/tulipfarm/issues/32)) ([4af9a11](https://github.com/TulipFarm/tulipfarm/commit/4af9a110624acb41d3687158fec22270cc637d23))
* @tulipfarm/validation — AJV + TypeBox stack (closes [#24](https://github.com/TulipFarm/tulipfarm/issues/24)) ([4576aea](https://github.com/TulipFarm/tulipfarm/commit/4576aea32dfa0baee0b1f3629c9bcb7d60b6423a))
* **surface:** declarative surfaces, HITL, live updates, and frontend tools ([#50](https://github.com/TulipFarm/tulipfarm/issues/50)) ([d53959e](https://github.com/TulipFarm/tulipfarm/commit/d53959efe43be7dd58b411a03ab2ba4b4baf069c))
* **surface:** native Surface interactions (TSP-V1-001/002) ([#41](https://github.com/TulipFarm/tulipfarm/issues/41)) ([d7f1c10](https://github.com/TulipFarm/tulipfarm/commit/d7f1c109547f7d67d04f56830eca21db0f2c4453))
* **surface:** native Chart component via inlined Chart.js, CSP-safe (AC-V1-003) ([#42](https://github.com/TulipFarm/tulipfarm/issues/42)) ([c2c72d6](https://github.com/TulipFarm/tulipfarm/commit/c2c72d6bee6f9b150a447f83533c6df059b2a780))
* **surface:** RecordTable rendering + schema-driven shell list sort/filter/pagination ([#39](https://github.com/TulipFarm/tulipfarm/issues/39)) ([244ce97](https://github.com/TulipFarm/tulipfarm/commit/244ce97d8f88897da587d9730cbbdd7ecfa3476f))
* **surface:** typed Form rendering, display-only (TSP-V1-002) ([#40](https://github.com/TulipFarm/tulipfarm/issues/40)) ([f28d08a](https://github.com/TulipFarm/tulipfarm/commit/f28d08ace5a6ccdc0d58537aeed887eca496f9e3))
* **surface:** TSP semantic component catalog (TSP-V1-002) ([#37](https://github.com/TulipFarm/tulipfarm/issues/37)) ([1361a07](https://github.com/TulipFarm/tulipfarm/commit/1361a0797fecefd75fd8c73a0bc12654039e97f0))
* admin-only secrets API (closes [#17](https://github.com/TulipFarm/tulipfarm/issues/17)) ([e5a85fe](https://github.com/TulipFarm/tulipfarm/commit/e5a85feba21c106817f008447648ede4dd13689e))
* AES-256-GCM secret storage in MongoDB (closes [#14](https://github.com/TulipFarm/tulipfarm/issues/14)) ([5bc70da](https://github.com/TulipFarm/tulipfarm/commit/5bc70da84c1460c63cc21136a499dd58f4b6a5dd))
* **agents,skills:** Agents UI + Skills UI with real SkillAudit install flow (UI-V1-003 / SKL-V1-002·003) ([db3e37c](https://github.com/TulipFarm/tulipfarm/commit/db3e37cd3c0484fbde888feba9e6dca8a560c830))
* **agents:** built-in GeneralAssistant + agent registry, per-turn resolution (AGT-V1-007) ([e581f1d](https://github.com/TulipFarm/tulipfarm/commit/e581f1d19f0d7d2b315d7be8c45518d69b428318))
* **agents:** write-time frontmatter meta-schema gate for agent_create/update (AGT-V1-005 / VAL-V1-010) ([9b2da87](https://github.com/TulipFarm/tulipfarm/commit/9b2da879f1283ad05ba5ea5b92c1cf27238f1d49))
* **approvals:** app-wide approvals surface — list page + live sidebar badge ([c7e0a50](https://github.com/TulipFarm/tulipfarm/commit/c7e0a505634a87a3b348996336d6363c57e87403))
* **approvals:** standalone /api/v1/approvals routes + DB table (AGT-V1-002) ([#36](https://github.com/TulipFarm/tulipfarm/issues/36)) ([2faa911](https://github.com/TulipFarm/tulipfarm/commit/2faa91117eb442dc1eea6b13348a3e0f0a83426a))
* basic CI pipeline with Biome lint, typecheck, and unit tests (closes [#5](https://github.com/TulipFarm/tulipfarm/issues/5)) ([f737e9f](https://github.com/TulipFarm/tulipfarm/commit/f737e9f4fa4a338b555013affec8842774f8b5f4))
* bearer API token auth (closes [#8](https://github.com/TulipFarm/tulipfarm/issues/8)) ([effc04d](https://github.com/TulipFarm/tulipfarm/commit/effc04d06d7c90d6ff147574f573106064e2d207))
* BullMQ repeatable down-sync every 5 min + push retry (closes [#19](https://github.com/TulipFarm/tulipfarm/issues/19)) ([7749ec8](https://github.com/TulipFarm/tulipfarm/commit/7749ec89f607318d0d8aee0d50e9238ca7276367))
* **chat+feedback:** Tiptap mentions, message feedback, chats browse, provenance ([#48](https://github.com/TulipFarm/tulipfarm/issues/48)) ([81566e9](https://github.com/TulipFarm/tulipfarm/commit/81566e9dad90a128f7936b60c3fa0beb456b302b))
* **chat:** agent [@mention](https://github.com/mention) routing, agent glyphs, mention chips, and stream stop ([#57](https://github.com/TulipFarm/tulipfarm/issues/57)) ([59344ec](https://github.com/TulipFarm/tulipfarm/commit/59344ec58753307ab6baa8a2fd919fbd4eac7b58))
* **chat:** dev-only debug drawer exposing raw conversation state + system prompt ([#58](https://github.com/TulipFarm/tulipfarm/issues/58)) ([5128d4d](https://github.com/TulipFarm/tulipfarm/commit/5128d4de3d933346011094a56f8c75c2f8c09dad))
* **chat:** durable conversation message store + paginated read API (CTX-V1-002) ([9406b86](https://github.com/TulipFarm/tulipfarm/commit/9406b86fc3782fe82613d63ca2c4d3b0b0112257))
* **chat:** durable SSE resume — stream_resume buffer + StreamHub + Last-Event-ID replay (DB-V1) ([f971bf8](https://github.com/TulipFarm/tulipfarm/commit/f971bf8ad4d09fb9f8c49f85258714da824511f9))
* **chat:** live chat shell — streaming UI, SSE backend, tool approvals ([#137](https://github.com/TulipFarm/tulipfarm/issues/137)) ([4c7316e](https://github.com/TulipFarm/tulipfarm/commit/4c7316e82957daba49e49b8370a3eb62640350ab))
* **chat:** persist, title, and browse chats + sidebar/model polish ([#47](https://github.com/TulipFarm/tulipfarm/issues/47)) ([2f41fd5](https://github.com/TulipFarm/tulipfarm/commit/2f41fd560c6ad1392e59fa03b0e917cbba66e12d))
* **chat:** POST /api/v1/chat streaming turn with per-turn model override (AC-V1-001) ([c77c577](https://github.com/TulipFarm/tulipfarm/commit/c77c577de5c8271706dcdca856c5a455aa58ab8f))
* **chat:** summarize-oldest conversation compaction (CTX-V1-001/002) ([#45](https://github.com/TulipFarm/tulipfarm/issues/45)) ([1faa552](https://github.com/TulipFarm/tulipfarm/commit/1faa552ca227e052ec0d7eb4d8d53a0f487f9596))
* **context:** deterministic assembleSystemPrompt — 9-block system prompt from durable stores (CTX-V1) ([dfc43ec](https://github.com/TulipFarm/tulipfarm/commit/dfc43ec0fe599d28203333845bdfed7a113cb43e))
* **context:** fill <soul-context> + <available-tools> prompt blocks ([#59](https://github.com/TulipFarm/tulipfarm/issues/59)) ([f9d7933](https://github.com/TulipFarm/tulipfarm/commit/f9d79336f909e2f21e319ee560f28524fe7455c8))
* CSRF double-submit cookie protection (closes [#9](https://github.com/TulipFarm/tulipfarm/issues/9)) ([e7897d0](https://github.com/TulipFarm/tulipfarm/commit/e7897d05b338439332afb044a6274fa3e16ea527))
* cursor pagination utility (closes [#11](https://github.com/TulipFarm/tulipfarm/issues/11)) ([ad87720](https://github.com/TulipFarm/tulipfarm/commit/ad877202e9fba1291356eec641b5111aaf58d261))
* **db:** migrate datastore from MongoDB+Redis to Postgres-only (DB-V1-001) ([a765452](https://github.com/TulipFarm/tulipfarm/commit/a7654524c534649fc7019b3847d8249e16caff91))
* **deploy:** single multi-arch app image, compose stack, CI parity gate ([67a8cef](https://github.com/TulipFarm/tulipfarm/commit/67a8cefa9cf186520004c2ec691cd9bbdb92934d)), closes [#184](https://github.com/TulipFarm/tulipfarm/issues/184) [#185](https://github.com/TulipFarm/tulipfarm/issues/185) [#188](https://github.com/TulipFarm/tulipfarm/issues/188)
* **docs:** documentation site with terminal-native landing page (DOC-V1-001) ([0967061](https://github.com/TulipFarm/tulipfarm/commit/09670618853e58c9e78487fe0cf13d226315fdec))
* dual-key graceful decryption + ENCRYPTION_KEY_PREVIOUS validation (closes [#16](https://github.com/TulipFarm/tulipfarm/issues/16)) ([0eeaa6c](https://github.com/TulipFarm/tulipfarm/commit/0eeaa6c5430ee22aba9195ea279bcbb9484b7588)), closes [#17](https://github.com/TulipFarm/tulipfarm/issues/17)
* Fastify server setup with CORS, helmet, and port 4010 (closes [#6](https://github.com/TulipFarm/tulipfarm/issues/6)) ([454c82a](https://github.com/TulipFarm/tulipfarm/commit/454c82aa7a9cb71e3e26d57ff3d2297b416edb02))
* **forge:** inbuilt General Assistant + Information Architect agents ([#46](https://github.com/TulipFarm/tulipfarm/issues/46)) ([75de67a](https://github.com/TulipFarm/tulipfarm/commit/75de67aaf28b5ff2171f14deb5b1e3d16546927c))
* **guardrails:** 3-stage guard framework with three V1 pattern guards ([#34](https://github.com/TulipFarm/tulipfarm/issues/34)) ([020689b](https://github.com/TulipFarm/tulipfarm/commit/020689b2213871213ef2c61929a3bbee69ffdefc))
* hook safety layers — L2 determinism, L3 static analysis, L5 operational controls ([b2e0c6f](https://github.com/TulipFarm/tulipfarm/commit/b2e0c6fe2105d9574920286e265f8cc232d58fb9))
* **knowledge:** web management UI + derived indexingStatus (UI-V1-003) ([#44](https://github.com/TulipFarm/tulipfarm/issues/44)) ([1b34b36](https://github.com/TulipFarm/tulipfarm/commit/1b34b36da9ff80aefb75bed4edaa53acb4f71e6a))
* **kv:** generic scoped key-value store (system/user/agent, jsonb, l… ([#62](https://github.com/TulipFarm/tulipfarm/issues/62)) ([1b71549](https://github.com/TulipFarm/tulipfarm/commit/1b715494e65dae7359294714a1eb09311244f157))
* **llm:** auto tier resolution — resolveTier rules + LlmService.select ([b0e11f7](https://github.com/TulipFarm/tulipfarm/commit/b0e11f7019ba1cf71ffe651dcacd1ad291ca467c))
* **llm:** embeddings provider config + priority resolution (LLM-V1-004) ([58e7d24](https://github.com/TulipFarm/tulipfarm/commit/58e7d24343522df03eb852652a3e27a60db32c00))
* **llm:** FallbackProvider hard/transient error classification + Pino fallback logging (AC-V1-002) ([bc27722](https://github.com/TulipFarm/tulipfarm/commit/bc277220109007f1cde445274285f936d8598e16))
* **llm:** surface SecretUnavailableError as clear LlmCredentialError (AC-V1-003) ([7ef23b5](https://github.com/TulipFarm/tulipfarm/commit/7ef23b5ed68e0e5adcb1dab3b9bcb04b6e8d06e0))
* **llm:** validate model id format + hot-reload llm.config on soul.synced (LLM-V1-003) ([d964f4c](https://github.com/TulipFarm/tulipfarm/commit/d964f4c8cc256808e59575c8f6a18bc40ce06e14))
* **memory:** per-user working memory store + update_memory/delete_memory tools wired into chat (MEM-V1-004) ([4c56dd6](https://github.com/TulipFarm/tulipfarm/commit/4c56dd622afaa72c112594e49d2cb3c75d871e8b))
* migration-on-boot framework (closes [#4](https://github.com/TulipFarm/tulipfarm/issues/4)) ([db1723e](https://github.com/TulipFarm/tulipfarm/commit/db1723e7e05929f3c96e792c21146516c2a76f76))
* **onboarding:** adaptive soul-derived suggestion chips over chat (ONB-V1-001/002/003) ([#43](https://github.com/TulipFarm/tulipfarm/issues/43)) ([3e81779](https://github.com/TulipFarm/tulipfarm/commit/3e8177990f3a8a180682e55986540d8899618fb5))
* OpenAPI 3.1 + Scalar UI (closes [#12](https://github.com/TulipFarm/tulipfarm/issues/12)) ([5efe32c](https://github.com/TulipFarm/tulipfarm/commit/5efe32c3c9d6047f4cba9f035450d8a8e0c3221f))
* rate limiting — sliding window per IP for auth endpoints (closes [#10](https://github.com/TulipFarm/tulipfarm/issues/10)) ([9e03c88](https://github.com/TulipFarm/tulipfarm/commit/9e03c88837f912c38801dae68a1efdafd02470ce))
* resource data CRUD — POST/GET/PUT/PATCH/DELETE with UUID id, If-Match concurrency, soft delete, history (closes [#29](https://github.com/TulipFarm/tulipfarm/issues/29)) ([10d3639](https://github.com/TulipFarm/tulipfarm/commit/10d3639aea1c9be7a772b55ede9d99de67aaafdb))
* resource type CRUD — POST/GET /api/v1/resource-types, YAML in/out, AJV meta-schema + x-* whitelist validation (closes [#28](https://github.com/TulipFarm/tulipfarm/issues/28)) ([48dd6d2](https://github.com/TulipFarm/tulipfarm/commit/48dd6d27114fe2e00bba4d677bb9f0188064cbd0))
* session auth (tf_sid cookie, Argon2id, Redis sessions) (closes [#7](https://github.com/TulipFarm/tulipfarm/issues/7)) ([05b2d63](https://github.com/TulipFarm/tulipfarm/commit/05b2d6309b472d9fca9fa39e75c9d082d4cef902))
* **settings:** provider-registry Settings — secrets + LLM config, Azure chat ([f5672f9](https://github.com/TulipFarm/tulipfarm/commit/f5672f939564261157791befcfaa50c7ea2bf392))
* **skills:** implement eager <skills> block in system-prompt assembly ([#32](https://github.com/TulipFarm/tulipfarm/issues/32)) ([76d707e](https://github.com/TulipFarm/tulipfarm/commit/76d707edd64dc38eabf5fae45edab2d66ebb8ff0))
* **skills:** Installed + Marketplace tabs with version-diff and clear audit errors ([#35](https://github.com/TulipFarm/tulipfarm/issues/35)) ([3447227](https://github.com/TulipFarm/tulipfarm/commit/3447227ef41528871f985331dc66e55d4683b50b))
* **skills:** render <available-skills> from SkillRegistry (all-lazy V1) ([#19](https://github.com/TulipFarm/tulipfarm/issues/19)) ([2a70fbb](https://github.com/TulipFarm/tulipfarm/commit/2a70fbbceee7a9761344c89c1e3a0278d0a647d9))
* **skills:** skill-forge triggers SkillAudit before activation (AC-V1-002) ([#38](https://github.com/TulipFarm/tulipfarm/issues/38)) ([30bab9a](https://github.com/TulipFarm/tulipfarm/commit/30bab9a77292e09c14a0b69bfbfe06a0f9d30c58))
* soul format migrations on boot (closes [#22](https://github.com/TulipFarm/tulipfarm/issues/22)) ([de9abc5](https://github.com/TulipFarm/tulipfarm/commit/de9abc56d9949073bd0899751fed57592b1c861b))
* soul git sync on boot + extract packages/soul and packages/secrets ([acc712d](https://github.com/TulipFarm/tulipfarm/commit/acc712de3dfee33b5fdad28813dce3f76a6933e1)), closes [#18](https://github.com/TulipFarm/tulipfarm/issues/18)
* soul_repo_commit + soul_repo_push tools + constants package (closes [#20](https://github.com/TulipFarm/tulipfarm/issues/20)) ([d9755d9](https://github.com/TulipFarm/tulipfarm/commit/d9755d92197b1f7a98b75422b51c6d22f2767bee))
* SoulLoader — parse all soul artifact types (closes [#21](https://github.com/TulipFarm/tulipfarm/issues/21)) ([f0fe95d](https://github.com/TulipFarm/tulipfarm/commit/f0fe95d2f562fee8c1fb5e6fca9c736dbae8bb48))
* **tools:** cap large results in LLM context, full result in SSE UI event (TOOL-V1-010) ([98e8c37](https://github.com/TulipFarm/tulipfarm/commit/98e8c371ea2c9c5caadc7c2315129a3e7ff3ab42))
* **tools:** central ToolRegistry + execution contract (TOOL-V1) ([a31c20d](https://github.com/TulipFarm/tulipfarm/commit/a31c20d5d1797a19480cdb65e592ab405df4e531))
* **tools:** create/list/schema/update resource-type tools + GitSyncService.withSync (TOOL-V1) ([1addc67](https://github.com/TulipFarm/tulipfarm/commit/1addc67e5ecb595d3f479d6222c67869fe56e628))
* **tools:** parallel reads, sequential writes per batch (TOOL-V1-008) ([f269d7c](https://github.com/TulipFarm/tulipfarm/commit/f269d7cf681c07b48580f84d289b0f4ae4547439))
* **tools:** platform tools — load_skill/reference, present, request_input, present, validate_artifact, transfer/delegate_to_agent (TOOL-V1) ([8183b03](https://github.com/TulipFarm/tulipfarm/commit/8183b038cfc3ab326474bc1c9603405567ac38ab))
* **tools:** resource_create/list/get/update/delete/search system tools (TOOL-V1) ([46b8f6f](https://github.com/TulipFarm/tulipfarm/commit/46b8f6f79550f14d3041206071666b7b20b70e4a))
* **tools:** soul + routine platform tools — trigger_routine, routine_picker, begin/end_soul_batch, soul_repo_commit/push, call_skill, complete_state (TOOL-V1-005) ([e5bd3d9](https://github.com/TulipFarm/tulipfarm/commit/e5bd3d9473242bfff6705670eefb4abbe75c8b82))
* **tools:** soul CRUD tools — agent_* and skill_* (TOOL-V1-005) ([2e0e98b](https://github.com/TulipFarm/tulipfarm/commit/2e0e98b77353183d8b165a4a53b1f9459547cdca))
* **tools:** validate tool args at registry level, return validation_error result (TOOL-V1-009) ([d4fbf01](https://github.com/TulipFarm/tulipfarm/commit/d4fbf01912e6124e1af0ee8d48643d5c6b79e1dd))
* **ui:** add Modal component and confirm delete for secrets ([#54](https://github.com/TulipFarm/tulipfarm/issues/54)) ([349bb76](https://github.com/TulipFarm/tulipfarm/commit/349bb76f459677a5ffc4f0dc1539b2ab73587288))
* validate all required env vars at API startup (closes [#13](https://github.com/TulipFarm/tulipfarm/issues/13)) ([7307b70](https://github.com/TulipFarm/tulipfarm/commit/7307b7058e953ecf9ba85b7a53477dcf2fa950fc))
* **web:** Tulip Surface Protocol security/rendering foundation — native component renderer (TSP-V1-004) ([15baa1f](https://github.com/TulipFarm/tulipfarm/commit/15baa1fc4b06fc988abebd83fcf4096529248071))
* **web:** frontend shell scaffold + UI craft pass (ruby terminal design system) ([bdb8b53](https://github.com/TulipFarm/tulipfarm/commit/bdb8b533c8182622bb871da3e538fb52a675bd18))
* **web:** schema-driven create + edit forms per resource type (UI-V1-002 write / AC-V1-002) ([a58c2ed](https://github.com/TulipFarm/tulipfarm/commit/a58c2edf4e47a17c8023c0eaa65883de999d87df))
* **web:** schema-driven Resources read-only list + detail (UI-V1-002) ([5a500cf](https://github.com/TulipFarm/tulipfarm/commit/5a500cff33909edadbad39871054142ca42e029e))
* wire pnpm dev with Turborepo watch for concurrent api+web dev ([f2890fe](https://github.com/TulipFarm/tulipfarm/commit/f2890fef49f9e9639086a24b3c825f4b3ab7f24c)), closes [#3](https://github.com/TulipFarm/tulipfarm/issues/3)
* x-links validate-on-write + orphan-on-delete (closes [#30](https://github.com/TulipFarm/tulipfarm/issues/30)) ([0a355fc](https://github.com/TulipFarm/tulipfarm/commit/0a355fc1c1aeaaf760fd04c8c8281eb8d66fa6b4))

### Bug Fixes

* **auth:** default ADMIN_EMAIL to a valid email ([4633719](https://github.com/TulipFarm/tulipfarm/commit/4633719a7d92856ffe012f2472b435187bd1c800))
* **ci:** pull the bundled postgres image in compose-parity ([c773488](https://github.com/TulipFarm/tulipfarm/commit/c773488c02e7abb67ed1c4d48e89aba20a5a4f1b))
* **llm:** disable strict tool schemas for openai/azure providers ([7be4bd9](https://github.com/TulipFarm/tulipfarm/commit/7be4bd908800035c9be9550abcd3a9d2a96058ed))
* **llm:** prevent boot crash when provider secrets are deleted ([#53](https://github.com/TulipFarm/tulipfarm/issues/53)) ([ffe78e5](https://github.com/TulipFarm/tulipfarm/commit/ffe78e5354531d5809e99e7f67d88a0cb57ce165))
* remove import of gitignored soul/migrate module ([881efab](https://github.com/TulipFarm/tulipfarm/commit/881efabb6b0e9200a97ee4e07a9cbcec524cca86))
* **setup:** use key-prefixed sed patterns to set distinct env secrets ([#51](https://github.com/TulipFarm/tulipfarm/issues/51)) ([dc0c745](https://github.com/TulipFarm/tulipfarm/commit/dc0c745dd8c4e568b40ccc581659561959730a73))
* **skills:** wire eager <skills> into prompt assembly; harden load_skill_reference vs path traversal ([#33](https://github.com/TulipFarm/tulipfarm/issues/33)) ([9218538](https://github.com/TulipFarm/tulipfarm/commit/9218538783d02413320a42c55328a48fea5498cf))
* wire hook subsystem; dedupe and harden resource write pipeline ([290eae0](https://github.com/TulipFarm/tulipfarm/commit/290eae015fe41373b181ccd16c02eb1de375e48f))

### Reverts

* Revert "chore: remove dependabot and CI workflows" ([8a259a9](https://github.com/TulipFarm/tulipfarm/commit/8a259a9689fff1a9a035be408b81dc4a98c056c7))
