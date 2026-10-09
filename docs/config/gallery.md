---
prefix: ipp.gallery
---

# Gallery

Options that control how the gallery page is rendered. Configured under `ipp.gallery`.

## Example

Show the gallery title and group photos by month:

```json
{
  "ipp": {
    "gallery": {
      "showTitle": true,
      "groupByDate": "month"
    }
  }
}
```

## `showTitle`

**Type:** `bool` · **Default:** `true`

Show a title on the gallery page. This is taken from the album title if it is an album being shared, otherwise the "Description" from the shared link will be used.

## `showDescription`

**Type:** `bool` · **Default:** `false`

Show the album description below the title. This only applies if it is an album which is being shared.

## `showExpiryDate`

**Type:** `bool` · **Default:** `false`

Show the share's expiry date next to the item count in the subtitle, as `45 items · available until 2026-07-10`. Only appears when the share actually has an expiry set in Immich (shares set to "never" show nothing extra).

## `expiryDateFormat`

**Type:** `string` · **Default:** `"YYYY-MM-DD"`

Format for the [`showExpiryDate`](#showexpirydate) date, as a [dayjs-style format string](https://day.js.org/docs/en/display/format) using the tokens `YYYY`, `YY`, `MMMM`, `MMM`, `MM`, `M`, `DD`, `D`, `dddd`, `ddd`, `dd`, `d`, `HH`, `H`, `hh`, `h`, `mm`, `m`, `ss`, `s`, `SSS`, `Z`, `ZZ`, `A` and `a`, with literal text in `[brackets]`. The default is ISO 8601 (e.g. `2026-07-10`). Example: `"D MMMM YYYY"` renders `10 July 2026`. Name-based tokens (`MMMM`, `dddd`, ...) render in English unless you also set [`expiryDateLocale`](#expirydatelocale).

> [!NOTE]
> Names come from the server's built-in locale data, which matches dayjs for English, long month and weekday names (including the `10 июля` form after a day number in Russian, Polish, Ukrainian, ...) and `A`/`a`. Some short names differ: `MMM` (German `Jul`, not `Juli`; Ukrainian and Portuguese add a trailing dot; Swedish `juli`), `ddd` (German/Spanish/Dutch without the trailing dot; Russian/Ukrainian `пт`, not `птн`; Polish `pt.`) and `dd` (Polish lower-case, Portuguese `se`, not `6ª`). Russian `A` reads `ночи` rather than `вечера` late in the evening, and Ukrainian `пʼятниця` uses a different apostrophe.

## `expiryDateLocale`

**Type:** `string` · **Default:** `""`

Language for the [`showExpiryDate`](#showexpirydate) date when the format uses names (e.g. `MMMM` for month names), as a [BCP 47 language tag](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Intl#locales_argument) such as `"de"`, `"fr"` or `"en-GB"`. The default is English, which is also used for a tag the server has no data for. The default numeric format needs no locale. The date-group headers from [`groupByDate`](#groupbydate) follow each visitor's own browser language instead.

## `showDownloadZip`

**Type:** `bool` · **Default:** `true`

Show the "download all" button in the header and the multi-select download toolbar. Only takes effect when downloads are allowed by [`allowDownload`](/config/ipp-options#allowdownload).

With it off, zip downloads are hidden while single downloads in the lightbox stay available ([`lightbox.showDownload`](/config/lightbox#showdownload)).

## `groupByDate`

**Type:** `bool` or `string` · **Default:** `false`

Group the gallery's thumbnails by date, with a header above each group.

- `false` - no grouping
- `"month"` - month headers like "December 2024"
- `"day"` - day headers like "Wed, 25 Dec 2024"
- `true` - the same as `"month"`

Grouping uses the date each photo was taken, and the headers use the same formats as Immich's own timeline. Groups follow the album's sort order in Immich, and newest first for shares without one. Photos with no date go under an "Undated" header at the end.

## `singleImage`

**Type:** `bool` · **Default:** `false`

Show a gallery page for a share that contains a single image, instead of opening the image file directly.

## `singleVideo`

**Type:** `bool` · **Default:** `true`

Show a gallery page for a share that contains a single video, instead of linking to the video file directly.

## `singleItemAutoOpen`

**Type:** `bool` · **Default:** `true`

When a share contains a single item and is opened on its gallery page, automatically open the lightbox on the asset.

## `cacheTime`

**Type:** `int` · **Default:** `300`

How long, in seconds, browsers and any CDN may cache the gallery page. A longer time means less load on your server, but new photos added to a share will not show for visitors until it runs out.
