# Игровая графика GoodGPT

Создана для проекта встроенным инструментом OpenAI imagegen, без сторонних паков игровых ресурсов. Использованы два независимых запроса с прозрачным фоном. В runtime изображения берутся только из пакета расширения.

`bag.png` - квадратный прозрачный спрайт открытого коричневого мешка. `treats.png` - прозрачный атлас, три колонки и два ряда. Каждая ячейка используется как отдельный спрайт прямо при рисовании Canvas, без извлечения в отдельные файлы. Иконки расширения уменьшены из мешка и включены в исходники.

## Запрос мешка

Single transparent 2D game sprite for the interactive browser extension GoodGPT. A beautifully crafted open brown burlap sack, a tangible high quality cozy RPG inventory object, front view with slight view into the open oval mouth. Entire sack upright centered inside a square canvas, filling 88 percent of height and 79 percent of width. Mouth center at x50%, y15%. Warm brown coarse woven hessian, visibly interlaced strands, folded rolled lip, thick hand stitched seam, convincing creases and soft ambient occlusion. Tactile painterly 3D rendered material with soft upper-left warm lighting. A few tiny hints of cookies and candy deep inside dark open mouth. Two small natural loop points on shoulders, no ropes attached. Genuinely transparent alpha, no ground plane, no scene, no lettering, no face, no limbs, no characters, no emoji, no icons.

## Запрос сладостей

Production game sprite atlas: exactly six separate high quality tactile 3D game sweets on a genuinely transparent square canvas, precise 3-column by 2-row grid of equal cells. One centered object per cell filling 72 percent, empty transparent margins. Top-left golden chocolate chip cookie, top-middle cherry red wrapped candy with cream stripe and twisted foil ends, top-right butterscotch caramel in translucent amber wrapper. Bottom-left chocolate sandwich biscuit with cream filling, bottom-middle sage green wrapped candy with ivory detail, bottom-right honey gold hard candy in clear golden wrapper. Consistent cozy RPG inventory quality, soft upper-left lighting, dimensional materials. No ground plane, no text, no labels, no dividers, no UI, no emojis, no characters. True transparent alpha.
