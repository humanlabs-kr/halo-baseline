---
name: translate-strings
description: Halo 미니앱(`apps/miniapp`)의 다국어 JSON 리소스를 40개 locale 전체에 자연스럽게 번역하는 워크플로우. 새 키/화면 추가 시 모든 locale 동기화. locale 별로 별도 Agent 를 병렬 spawn 해서 WebSearch 로 native 표현을 확인한 뒤 자기 locale json 에 직접 쓰게 한다. "번역", "i18n 채워", "locales 채워", "다국어 추가", "새 화면 번역" 같은 요청에 트리거. Python dict / 일괄 자동 번역 금지 — 항상 이 워크플로우를 쓴다.
---

# Halo 미니앱 다국어 번역

`apps/miniapp` 은 World App · MiniPay · LINE(Kaia) 웹뷰에서 도는 React + Vite SPA 다.
사용자가 종이 영수증을 찍으면 비전 모델이 판독·채점하고, 통과한 영수증이 포인트가 되어
Celo / World Chain / Kaia 에서 토큰으로 청구된다.

i18n 리소스는 `apps/miniapp/src/lib/i18n/locales/{locale}.json` 한 곳에 모인다.
설정은 `apps/miniapp/src/lib/i18n/index.ts`, 언어는 i18next + browser language detector 가
OS/브라우저 설정이나 사용자가 고른 값(`localStorage['halo.lang']`)으로 정한다.

**경로는 전부 레포 루트 기준 상대경로로 쓴다.** 절대경로를 박으면 다른 머신에서 스킬이 죽는다.

## 이 레포의 키가 두 종류라는 것부터 알 것

| 종류 | 예 | 성질 |
|---|---|---|
| **불투명 id** (126개) | `L-0CAAm7Uq` | 값이 없으면 화면에 **키 문자열이 그대로 노출**된다. 전 locale 필수 |
| **자연어 키** (89개) | `"10K Points + {{brand}} Rewards"` | 키 자체가 영어 원문이다. 없으면 **영어로 정확히 폴백**되므로 누락이 사고는 아니다 |

`scripts/check-locales.mjs` 가 이 구분대로 검사한다 — 불투명 id 누락은 **실패**, 자연어 키
누락은 **warn**. 번역을 채우는 것이 목표지만, 급하면 자연어 키는 뒤로 미뤄도 화면은 멀쩡하다.

> ⚠️ **`keySeparator` / `nsSeparator` 는 `false` 여야 한다** (`lib/i18n/index.ts`).
> 자연어 키에는 `.` 과 `:` 가 들어 있어서, 기본값(`.`/`:`)이면 i18next 가 키를 중첩 경로로
> 쪼개다 실패해 번역이 **영원히 해석되지 않는다.** 원본 앱이 이 상태였고 아무도 몰랐다.

## 절차

### 1. source (en.json) 확정
`apps/miniapp/src/lib/i18n/locales/en.json` 에 영문 원본을 먼저 확정한다. 자연어 키를 새로
쓸 때는 **키와 값이 같은 문자열**이 되도록 넣는다(그래야 폴백이 자연스럽다).

```bash
pnpm --filter @halo/miniapp exec tsc --noEmit
pnpm --filter @halo/miniapp test        # check-locales
```

### 2. 대상 locale 확인
```bash
ls apps/miniapp/src/lib/i18n/locales/
```
`SUPPORTED_LANGS`(`lib/i18n/index.ts`)가 단일 진실이다. 현재 40개, `en` 제외 39개가 대상.

### 3. locale 별 Agent 병렬 spawn ← 핵심

- **한 메시지 안에** 여러 `Agent` 호출을 동시에 쓴다. 순차 호출 금지.
- 39개를 한 번에 띄우기 버거우면 **12~13개씩 묶어 여러 파도로** 나눈다. 파도 안에서는 반드시 병렬.
- 각 agent 는 자기 locale 하나만 책임진다. 부모에게 번역문을 보고하지 말고
  **자기 locale json 을 Write 로 직접 덮어쓴다.**
- 끝나면 대표 문자열 2~3개만 보고 → 부모가 sanity check.

### 4. 검증
```bash
pnpm --filter @halo/miniapp test                # check-locales: 키 누락·placeholder 불일치
pnpm --filter @halo/miniapp exec vite build
```
JSON 파싱 에러가 나면 **그 locale 만** 다시 돌린다.

가능하면 실제로 띄워서 눈으로 본다 — 언어 드로어에서 해당 언어를 고르고 홈·스캔·리워드
화면에서 글자가 잘리거나 버튼을 넘치지 않는지. 독일어·프랑스어는 영어보다 30% 길어져
버튼이 깨지는 대표 언어다.

## Agent prompt 템플릿

```
You are localizing the Halo mini app's UI strings to {LOCALE_CODE} ({LANGUAGE_FULL_NAME}).

Target file:  apps/miniapp/src/lib/i18n/locales/{LOCALE_CODE}.json
Source file:  apps/miniapp/src/lib/i18n/locales/en.json
(Both paths are relative to the repository root.)

PRODUCT CONTEXT
- Halo is a mini app that runs inside a crypto wallet's webview: World App, MiniPay
  (Opera's wallet, mostly Africa + Latin America), and LINE's Kaia wallet (mostly Asia).
- Core loop: the user photographs a paper receipt → a vision model reads and scores it →
  a passing receipt becomes points → the user claims those points as real tokens
  (USDC on World Chain, USDT on Celo and Kaia) from their own wallet.
- There is also a daily claim, a raffle with prize pools, and email verification.
- Tone: plain, concrete, trustworthy. Real money is involved, so avoid hype and avoid
  cutesy game language — but it is not legal boilerplate either. Short and clear.
- Surface: narrow mobile webview. Most strings are button labels, toasts, empty states,
  and one-line explanations under a heading. Long translations break the layout.
- Audience: ordinary phone users in {REGION}, many on entry-level Android and metered
  data, who are new to crypto. Write for someone who has never heard the word "onchain".

REQUIRED STEPS

1. Read en.json first. Mirror its key set exactly.

2. Use WebSearch 1–2 times to check how real apps in {LANGUAGE} phrase these concepts.
   Do not literal-translate. Useful probes: receipt / proof of purchase, cashback and
   rewards apps, "scan", "claim", "daily bonus", "prize draw", "verify your email",
   crypto wallet UI wording. Borrow the idioms those apps actually use.

3. Translate every value. Leave untouched:
   - JSON keys themselves. This includes the natural-language keys — the key stays
     English, only the value is translated.
   - i18next placeholders: `{{brand}}`, `{{count}}`, `{{amount}}`, `{{date}}`, etc.
     Keep the variable name character-for-character. You may move it within the
     sentence so the grammar works.
   - Brand and product names: Halo, Halo Mini, World App, World ID, World Chain,
     MiniPay, Celo, Kaia, LINE, USDC, USDT, Google Play, PayPal, Visa.
     Keep the Latin form unless your language has a strongly conventional native
     spelling (Japanese カタカナ is fine where that is the standard).
   - Emoji and special punctuation exactly as they appear: `…` (never expand to `...`),
     `·`, `›`, `/`, flag emoji, `🎁`.
   - Country names inside cross-promo strings stay the local name of that country.

4. JSON escaping: `"` → `\"`, `\` → `\\`, newline → the two literal characters `\n`.
   Never put a real newline inside a string value.

5. Keep the exact key order of en.json. Same number of keys — no additions, no removals.

6. Length discipline. If your natural translation is more than ~30% longer than the
   English, shorten it — these are buttons and one-line labels in a narrow column.
   Prefer the shorter of two correct options.

7. Write the result with the Write tool, overwriting the whole file. It must be valid
   JSON that `JSON.parse` accepts.

8. Report back 2–3 example strings so the parent can sanity-check, and say which
   WebSearch queries you used.

Do not touch any other file. Do not add comments. Do not add or remove keys.
```

## 지원 locale (40)

`apps/miniapp/src/lib/i18n/index.ts` 의 `SUPPORTED_LANGS` 가 단일 진실이다.

```
en        English — source, agent 불필요
en-GB     English (UK) — 철자만 다름. 기계적으로 처리 가능
ar        العربية (RTL)          bn   বাংলা
de-AT     Deutsch (Österreich)   de-CH Deutsch (Schweiz)    de-DE Deutsch
es-419    Español (LatAm)        es-ES Español (España)
fa        فارسی (RTL)            fr-CA Français (Canada)    fr-FR Français
hi        हिन्दी                    id   Bahasa Indonesia
it        Italiano               ja   日本語
kn        ಕನ್ನಡ                    ko   한국어
mr        मराठी                   ms-ID Bahasa Melayu (ID)   ms-MY Bahasa Melayu (MY)
nl-BE     Nederlands (BE)        nl-NL Nederlands
pa-Arab   پنجابی (RTL)           pa-Guru ਪੰਜਾਬੀ
pl        Polski                 pt-BR Português (Brasil)   pt-PT Português (Portugal)
ru        Русский                sw   Kiswahili
ta        தமிழ்                    te   తెలుగు
th        ไทย                     tl   Filipino
tr        Türkçe                 uk   Українська
ur        اردو (RTL)              vi   Tiếng Việt
zh-CN     简体中文                 zh-TW 繁體中文
```

지역 변종(`de-AT`/`de-CH`/`de-DE`, `fr-CA`/`fr-FR`, `ms-ID`/`ms-MY`, `nl-BE`/`nl-NL`,
`pt-BR`/`pt-PT`, `es-419`/`es-ES`)은 **서로 다른 파일로 유지**한다. 같은 언어라도
통화 표기·격식·어휘가 갈린다(예: `pt-BR` "celular" vs `pt-PT` "telemóvel").
복사해 두고 넘어가지 말 것 — 그건 번역한 게 아니다.

RTL(`ar`, `fa`, `ur`, `pa-Arab`)은 문자열 자체는 평범하게 번역하면 된다. 레이아웃 방향은
CSS 문제이고 이 스킬 범위가 아니다.

## 금지 사항

- ❌ Python dict / 외부 번역 API 로 일괄 채우기 — 관용구를 무시해 어색해진다.
- ❌ 한 agent 가 여러 locale 처리 — 깊이가 안 나온다.
- ❌ 같은 prompt 로 sequential 호출 — 반드시 한 메시지 안 병렬.
- ❌ 지역 변종을 같은 내용으로 복사.
- ❌ 브랜드명 · 토큰 심볼 · JSON 키 번역.
- ❌ placeholder 변수명 변경 — 코드와 어긋나면 화면에 `{{brand}}` 가 그대로 뜬다.
- ❌ 이모지 · `…` · `·` · `›` 변경.
- ❌ en.json 의 키 순서 변경, 키 추가/삭제.
- ❌ 번역을 채우고 `check-locales` 를 안 돌리는 것.
