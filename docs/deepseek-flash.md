# DeepSeek Flash configuration

Verified against the official DeepSeek documentation on 2026-09-10.

## Model and reasoning

`deepseek-flash` now serves **DeepSeek-V4.1-Flash**, with a 1M-token
context window. Bubble exposes `off`, `low`, `high`, and `max`; `high` is
the default, not a restriction to a single effort.

For Chat Completions, `off` sends `thinking: { type: "disabled" }` and
omits `reasoning_effort`. Other choices enable thinking and send the chosen
`reasoning_effort`. With tools, previous reasoning is replayed in thinking
mode as required by the API.

The API also accepts effort aliases: `minimal → low`, `medium/xhigh → high`,
and `ultra → max`. The menu exposes the actual effort levels rather than
these aliases. Bubble's generic normalization rules still apply to
unsupported explicit CLI/config values.

## Prices per million tokens

| Usage | USD peak | USD off-peak | CNY peak | CNY off-peak |
| --- | ---: | ---: | ---: | ---: |
| Input, cache hit | $0.006 | $0.003 | ¥0.04 | ¥0.02 |
| Input, cache miss | $0.30 | $0.15 | ¥2.00 | ¥1.00 |
| Output | $1.20 | $0.60 | ¥8.00 | ¥4.00 |

Bubble estimates DeepSeek usage in **USD**, matching its existing pricing
currency. The CNY amounts above are the official Chinese price list, not
an exchange-rate conversion. The published prices do not vary by effort.

Peak hours are Monday–Friday **01:00–04:00 and 06:00–10:00 UTC**
(09:00–12:00 and 14:00–18:00 Beijing time). All other times, including
weekends, use the off-peak rates. Window starts are inclusive; ends are
exclusive.

The new tariff takes effect at **2026-09-10 04:00 UTC**. Legacy model IDs
`deepseek-v4-flash` and `deepseek-v4-flash-vision-exp` now route to V4.1 Flash
and use these prices. Their earlier usage retains the applicable historical
tariffs, including the older 2026-08-16 transition.

At **2026-09-14 04:00 UTC**, `deepseek-v4-pro` also switches to Flash pricing.
The official notice says this routing remains until V4.1 Pro launches;
check the documentation again when that happens.

## Official sources

- [Thinking mode and effort control](https://api-docs.deepseek.com/guides/thinking_mode)
- [USD pricing, aliases, and peak schedule](https://api-docs.deepseek.com/quick_start/pricing)
- [CNY pricing](https://api-docs.deepseek.com/zh-cn/quick_start/pricing)
- [September 10 release and exact tariff transition times](https://api-docs.deepseek.com/news/news260910)
