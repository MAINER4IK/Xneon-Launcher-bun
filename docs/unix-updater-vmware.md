# Проверка Unix Updater в VMware

Это руководство для **будущего ручного E2E настоящего Xneon Launcher**. Unit-тесты,
filesystem-тесты, fixture дочернего процесса и сборка не заменяют этот E2E.
Нужна отдельная VM с графическим рабочим столом, не Xvfb и не CI GUI smoke.
Никаких публикаций GitHub Releases или изменений production allowlist не требуется.

## 1. Изоляция

- Ubuntu 24.04 x64 Desktop: AppImage, пользовательский TAR.XZ, DEB и системный TAR.
- Отдельные Fedora x64 и Arch x64: RPM и Pacman. Наличие `rpm` на Ubuntu не
  подтверждает работу RPM-установки на Fedora.
- Сделайте VMware snapshot. Не подключайте каталог настоящего профиля через shared folders.
- Работайте обычным пользователем; root нужен только менеджеру пакетов и настройке VM.
- Установите Bun **1.4.4**, Git, OpenSSL, `jq`, Caddy, mkcert; зависимости Linux-сборки
  перечислены в `.github/actions/setup/action.yml` (`linux-native-build`).
- Расположите исходники и пользовательские TAR-инсталляции **внутри `$HOME`**.

```bash
git clone --branch feature/unix-native-acceptance https://github.com/MAINER4IK/Xneon-Launcher-bun.git "$HOME/xneon-updater-vm"
cd "$HOME/xneon-updater-vm"
bun --version
bun install --frozen-lockfile
mkdir -p .local-research/vm/{keys,feeds,releases}
export XNEON_BUN_DATA_DIR="$HOME/xneon-vm-profile"
mkdir -p "$XNEON_BUN_DATA_DIR"
```

`XNEON_BUN_DATA_DIR` необходимо сохранять при **каждом** запуске, включая запуск
AppImage. Helper наследует этот профиль. Runtime, БД и профиль не должны быть внутри
заменяемого приложения или AppImage mount.

## 2. Тестовые HTTPS и Ed25519 — только в этой копии исходников

Production-бинарники намеренно не принимают ключи и URL из runtime environment.
Для частного E2E подготовьте отдельные VM-бинарники с одинаковым test pinning в A/B
**и в standalone helper**. Не используйте production private key.
Следующие изменения относятся исключительно к клону VM, их нельзя отправлять в рабочую ветку.

```bash
openssl genpkey -algorithm ED25519 -out .local-research/vm/keys/update-private.pem
chmod 600 .local-research/vm/keys/update-private.pem
openssl pkey -in .local-research/vm/keys/update-private.pem -pubout -out .local-research/vm/keys/update-public.pem
python3 - <<'PY'
from pathlib import Path
import json
root = Path.cwd()
key = (root / '.local-research/vm/keys/update-public.pem').read_text()
trust = root / 'electrobun/main/update-public-keys.ts'
assert trust.exists(), 'Unexpected checkout layout'
# В одноразовом VM-клоне заменяется только pinning доверия; updater-логика не меняется.
trust.write_text('export const updatePublicKeys = { vmtest: ' + json.dumps(key) + ' }\n'
    + 'export function expectedUpdateBaseUrl(channel: "stable" | "canary") {\n'
    + '  return channel === "stable" ? "https://updates.xneon.test/releases/latest/download" : "https://updates.xneon.test/releases/download/canary"\n}\n')
PY
mkcert -install
mkcert -cert-file .local-research/vm/keys/https.pem -key-file .local-research/vm/keys/https-key.pem updates.xneon.test
export NODE_EXTRA_CA_CERTS="$(mkcert -CAROOT)/rootCA.pem"
```

Добавьте `127.0.0.1 updates.xneon.test` в `/etc/hosts` **внутри VM**.
Не отключайте TLS verification (`NODE_TLS_REJECT_UNAUTHORIZED=0`, `curl -k` и аналоги запрещены).
Создайте Caddyfile с абсолютными путями, выведенными `pwd`:

```caddyfile
updates.xneon.test {
    bind 127.0.0.1
    tls /home/USER/xneon-updater-vm/.local-research/vm/keys/https.pem /home/USER/xneon-updater-vm/.local-research/vm/keys/https-key.pem
    root * /home/USER/xneon-updater-vm/.local-research/vm/feeds
    file_server
}
```

Запустите Caddy на 443, затем проверьте обычный HTTPS-запрос без обхода проверки
сертификата. Приватные ключи находятся **вне HTTP root**. Не копируйте их в payload.
Windows `update-public-keys.ts` и Windows updater не изменяются: test pinning нужен
общему `update-public-keys`, который читают и платформенные verifier-ы, и единый signer.
Схема документа и подписи у Windows и Unix одна — Manifest v1 и Ed25519.

## 3. Собрать и подписать A и B до начала установки

Используйте реальные stable-версии: A=`1.0.7`, B=`1.0.8`. Stable-канал принимает
только финальные версии (prerelease в stable отвергается verifier-ом), поэтому
цепочка ограничена двумя шагами до следующего публичного выпуска. Для canary
соберите ту же версию `1.0.8` через `bun run build:canary`: канал задаётся сборкой,
а не номером версии. Сборки существуют только в VM и никогда не публикуются.
Каждой версии нужен собственный SDK build hash.
Для каждой stable-версии, меняя `VERSION` и `LABEL`, выполните:

```bash
export VERSION=1.0.7 LABEL=A
VERSION="$VERSION" bun -e 'const file = Bun.file("package.json"); const value = await file.json(); value.version = process.env.VERSION; await Bun.write(file, JSON.stringify(value, null, 2) + "\n")'
bun run build
mkdir -p ".local-research/vm/releases/$LABEL"
bun scripts/electrobun-artifacts.ts stage release-electrobun/stable ".local-research/vm/releases/$LABEL/native" linux x64 stable
bun scripts/package-linux.ts ".local-research/vm/releases/$LABEL/native" ".local-research/vm/releases/$LABEL/packages"
XNLC_UPDATE_KEY_ID=vmtest XNLC_UPDATE_PRIVATE_KEY="$(cat .local-research/vm/keys/update-private.pem)" bun scripts/sign-update-feed.ts stable ".local-research/vm/releases/$LABEL/native" ".local-research/vm/releases/$LABEL/signed" linux x64 ".local-research/vm/releases/$LABEL/packages"
bun scripts/verify-signed-update-feed.ts ".local-research/vm/releases/$LABEL/signed" linux x64
```

Signer публикует один и тот же подписанный Manifest v1 под двумя именами:
`<channel>-linux-x64-update.json` (канонический, его читает Unix updater) и
`<channel>-linux-x64-update-v2.json` (байт-идентичный алиас для SDK и выпущенных
Windows-клиентов). Оба `.sig` обязательны.

Повторите для B (`VERSION=1.0.8 LABEL=B`). Для canary применяются
`bun run build:canary`, каталог `release-electrobun/canary` и аргумент `canary`
вместо `stable` в обоих scripts.
Не подписывайте A после смены package.json на B: signer проверяет точную версию.
Native `-update.json`/`-update-v2.json` не редактируются: signer собирает из них
расширенный v1 (с `download*`, `distributions`) и пишет его в новый каталог.

```bash
mkdir -p .local-research/vm/feeds/releases/latest
ln -s "$PWD/.local-research/vm/releases/A/signed" .local-research/vm/feeds/releases/latest/download
```

Переключение test stable feed на B выполняется атомарной заменой **ссылки test feed**:

```bash
ln -s "$PWD/.local-research/vm/releases/B/signed" .local-research/vm/feeds/releases/latest/download.next
mv -Tf .local-research/vm/feeds/releases/latest/download.next .local-research/vm/feeds/releases/latest/download
```

`feeds/releases/download/canary` аналогично указывает на подписанный canary candidate.
Не меняйте origin/канал/подпись уже работающей A вручную.

## 4. Настоящая установка и сценарии

Для каждого формата используйте свежий VMware snapshot и отдельный профиль.

- **AppImage:** скопировать A в постоянный пользовательский каталог, `chmod +x`,
  запускать непосредственно файл. Нужен рабочий FUSE для AppImage, не ручная распаковка.
- **TAR.XZ пользователя:** распаковать A обычным пользователем в `$HOME/vm-tar-A`;
  запускать `$HOME/vm-tar-A/opt/xneon-launcher/bin/launcher`. В `Resources` должен быть
  `update-installation.json`. Не удаляйте `usr`/`opt` из тестовой установки между обновлениями.
- **DEB:** установить A через `sudo apt-get install /полный/путь/к/A.deb`, запускать
  `/opt/xneon-launcher/bin/launcher`. Запросы `pkexec` подтверждаются в настоящем desktop.
- **RPM/Pacman:** такие же действия в соответствующей Fedora/Arch VM через `dnf install`
  и `pacman -U`. После обновления сверять native package version/configured state.
- **Системный TAR в `/opt`:** автоматическая перезапись должна быть отклонена;
  проверить отсутствие изменений в `/opt` после отказа. Это не portable и не package-manager install.

В A задайте тему, настройки памяти, offline-аккаунт и тестовую сборку с sentinel-файлом.
Запишите SHA-256 sentinel и значения SQLite; не используйте рабочие аккаунты/токены.
Через UI выполнить и сохранить доказательства:

1. Проверка B → скачивание B → «Позже». Закрыть/открыть приложение: применяется B (`1.0.8`).
2. Вернуть A (`1.0.7`), затем проверить B → скачивание B → «Перезапустить сейчас»:
   появляется настоящая B. Второй путь проверяет немедленный перезапуск.
3. Смена stable/canary **только выбирает канал**. Отдельно проверить/скачать/установить;
   выполнить обратный переход при явной смене канала (обе сборки — `1.0.8`,
   отличается только канал).
4. После каждого шага сверить `Resources/version.json`, SHA-256 бинарников,
   настройки/аккаунты/sentinel. Убедиться, что helper runtime находился вне заменяемого app.
5. Подмена одного байта payload/manifest/signature должна блокироваться до замены.
6. Отмена в UI, отказ polkit, нехватка места, read-only каталог: A и профиль сохраняются.

## 5. Сбойные сценарии

Автоматического отката в Unix updater нет: при сбое helper останавливает новый процесс
и записывает `failed`/`cancelled`, а прежняя версия сама не запускается. `previous`
рядом с приложением и `profile-backup` остаются для ручного восстановления. Поэтому
проверяются две разные ситуации.

**Сбой до замены** (битая подпись/байт payload, нехватка места, read-only каталог,
отмена, отказ polkit): target и профиль остаются прежними, helper пишет `failed` или
`cancelled`, следующий запуск A проходит нормально. Проверьте `result.json`,
`last-result.json` и отсутствие нового `previous` либо незавершённой подмены.

**Сбой после замены** (заведомо неисправная B): соберите отдельную B до подписания и
установите её через UI. Убедитесь, что:

- helper завершился с `result.json.status = "failed"`, новый процесс B остановлен;
- следующий запуск не открывает неподтверждённую B, а завершается с
  `update-recovery-required`; `last-result.json.status = "failed"`;
- `previous` рядом с приложением (`.xneon-update-<nonce>/previous`) и
  `profile-backup/previous-data.db` + `database-snapshot.json` сохранены.

Затем вручную верните A. Остановите лаунчер и замените target содержимым `previous`
(для каталога и `.app` — rename при остановленном приложении; для AppImage — обычный
`mv`). Если нужно вернуть и БД, скопируйте `profile-backup/previous-data.db` на место
`data.db` и удалите `data.db-wal`/`data.db-shm`; при `existed: false` в
`database-snapshot.json` БД до обновления не было. После этого запуск должен снова
открыть A, а helper снимет active по сохранённому результату `failed`.

- Сохранённые `previous`, `profile-backup`, `job.json`, `ready.json`, `helper.log` и
  `result.json` нельзя считать пользовательским мусором: это материал ручного разбора.
- Во время обновления попробуйте второй запуск лаунчера; он не должен открыть профиль
  параллельно с helper. Повреждённый `active.json`/job должен приводить к fail-closed,
  а не к продолжению startup с непроверенной БД.

Артефакты проверки: `<profile>/system-cache/unix-update-helper/<nonce>/`
(`job.json`, `ready.json`, `helper.log`, `result.json`, `profile-backup`),
`<profile>/system-cache/unix-update-health/health-<nonce>.json`,
соседний с app `.xneon-update-<nonce>/state.json` либо `package-transaction.json`,
`last-result.json`, native package-manager query, снимки реального UI и VMware snapshots.
Не публикуйте профиль/ключи/аккаунты вместе с отчётом.

PASS разрешён только после наблюдения настоящего приложения, реального применения,
перезапуска и сохранности данных. Неисполненные форматы и macOS помечаются `NOT RUN`.
