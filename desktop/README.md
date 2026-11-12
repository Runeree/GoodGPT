# GoodGPT для рабочего стола

Мешочек с угощениями для **Codex (ChatGPT)** и **Claude Code в приложении Claude**. После восьми сладостей приложение сразу пытается отправить одну похвалу через обычный интерфейс чата.

| Платформа | Скачать | Инструкция |
| --- | --- | --- |
| Windows 10 / 11 | [GoodGPT-Windows.exe](https://github.com/Runeree/GoodGPT/releases/latest/download/GoodGPT-Windows.exe) | [Windows](windows/README.md) |
| macOS 12 и новее | [GoodGPT-macOS.zip](https://github.com/Runeree/GoodGPT/releases/latest/download/GoodGPT-macOS.zip) | [macOS](macos/README.md) |
| Ubuntu / Debian, X11 | [GoodGPT-Linux.deb](https://github.com/Runeree/GoodGPT/releases/latest/download/GoodGPT-Linux.deb) | [Linux](linux/README.md) |

Windows использует WPF и UI Automation, macOS использует AppKit и JavaScript for Automation, Linux использует Python, GTK3 и AT-SPI. Node.js для готовых приложений не нужен. В Linux системные зависимости устанавливаются командой `sudo apt install ./GoodGPT-Linux.deb`, затем GoodGPT появляется в меню приложений. Нужен X11 с композитингом; на Wayland используйте расширение браузера для сайта ChatGPT.

Зажмите мешок, потяните вниз и переверните колёсиком или движением мыши с Shift. Отпустите, чтобы он вернулся наверх. За одно высыпание отправляется одна похвала.

Откройте доступную установленную сборку Codex или выберите вкладку **Code** в приложении **Claude**, затем нужный диалог. GoodGPT не устанавливает эти приложения. Приложение отправляет похвалу и во время ответа ИИ через обычную отправку или очередь. Черновики и вложения не заменяются. Совместимость зависит от доступности поля через системные средства специальных возможностей. Возле мешка нет надписей и обводки. В Linux управление открывается правой кнопкой на мешке.

Готовые приложения не подписаны сертификатами издателей. Сборка Windows и структура пакета macOS проверены в Windows. На настоящем Mac приложение пока не запускалось; реальная отправка в диалоги требует ручной проверки.

Сборка из корня проекта в Windows:

```powershell
npm run desktop:windows
npm run desktop:macos
npm run desktop:linux
npm run desktop:check
```

Результат находится в `dist/`. Сборка macOS формирует пакет `.app` с исполняемым launcher и сохраняет Unix-права в ZIP. Сторонних npm-зависимостей нет.
