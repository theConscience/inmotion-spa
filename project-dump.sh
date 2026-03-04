#!/usr/bin/env bash
# Собирает исходники из указанных каталогов + (опционально) из корня в один Markdown.
# Режет большие файлы, ограничивает общий размер, игнорит бинарники, lock-файлы,
# дампы project-dump*.md и кучу мусорных директорий. Поддерживает кириллицу.

set -euo pipefail

# -------- Значения по умолчанию --------
export LANG=en_US.UTF-8     # чтобы printf/grep не корёжили кириллицу
export LC_ALL=en_US.UTF-8

OUT="project-dump.md"       # имя выходного файла
PER_FILE_MAX=$((64 * 1024)) # максимум на файл (байт)
TOTAL_MAX=$((20 * 1024 * 1024)) # общий потолок дампа (байт)
INCLUDE_ROOT=true           # включать файлы из корня проекта (без рекурсии)
DIRS=(app server)           # каталоги по умолчанию (рекурсивно)

ALLOW_BASENAME_DEF=(Dockerfile dockerfile Makefile makefile Caddyfile caddyfile)
ALLOW_BASENAME=("${ALLOW_BASENAME_DEF[@]}")

# Базовые исключаемые префиксы путей (каталоги)
EXCLUDES_DEF=(
  ".git" "node_modules" ".nuxt" "dist" ".output" "coverage" ".cache" ".turbo"
  ".next" ".idea" ".vscode" "build" "logs" "log" "storage" "static"
  "public/assets" "public/uploads" "assets/images" "assets/img"
)
EXCLUDES=("${EXCLUDES_DEF[@]}")

# Белый список расширений (чтобы не тащить ассеты)
ALLOW_EXT_DEF=(vue ts tsx js mjs cjs json css postcss scss sass less md markdown yaml yml html sh bash env conf ini txt)
ALLOW_EXT=("${ALLOW_EXT_DEF[@]}")

# Lock-файлы — исключаем по умолчанию
EXCL_LOCKS=true
LOCK_PATTERNS_DEF=(
  "*.lock" "package-lock.json" "pnpm-lock.yaml" "yarn.lock" "bun.lockb"
  "composer.lock" "poetry.lock" "Pipfile.lock" "Cargo.lock" "Podfile.lock"
  "gradle.lockfile" "Gemfile.lock" "mix.lock" "go.sum" "requirements.lock"
)
LOCK_PATTERNS=("${LOCK_PATTERNS_DEF[@]}")

# Всегда игнорим любые дампы project-dump*.md (чтобы не самопожрался)
EXTRA_GLOBS=("project-dump*.md")

has_allowed_basename() {
  local b
  b="$(basename "$1")"
  for x in "${ALLOW_BASENAME[@]}"; do [[ "$b" == "$x" ]] && return 0; done
  return 1
}

# -------- Хелп и утилиты --------
usage() {
  cat <<EOF
Usage: $(basename "$0") [options]

Options:
  -o, --out FILE             Output markdown file (default: $OUT)
  -d, --dirs LIST            Comma-separated dirs to include (default: ${DIRS[*]})
  -R, --no-root              Do NOT include files from project root (default: include)
  -e, --allow-ext LIST       Comma-separated whitelist of extensions (override defaults)
  -a, --add-ext LIST         Add extensions to whitelist (in addition to defaults)
  -x, --exclude-dirs LIST    Comma-separated dir prefixes to exclude (adds to defaults)
  -X, --only-excludes LIST   Comma-separated dir prefixes (REPLACE defaults)
  -g, --exclude-glob LIST    Comma-separated extra file globs to exclude (e.g. "*.map,*.min.*")
  -L, --no-locks             Do NOT auto-exclude lock files (default: excluded)
  -p, --per-file-max BYTES   Per-file max bytes (default: $PER_FILE_MAX)
  -t, --total-max BYTES      Total dump size cap (default: $TOTAL_MAX)
  -h, --help                 Show help
EOF
}

# Проверка расширения на попадание в белый список
has_ext() {
  local e="${1##*.}"
  for x in "${ALLOW_EXT[@]}"; do [[ "$e" == "$x" ]] && return 0; done
  return 1
}

# Проверка по префиксам исключаемых путей (каталоги)
is_excluded_path() {
  local p="${1#./}"
  for ex in "${EXCLUDES[@]}"; do
    ex="${ex#./}"
    [[ "$p" == "$ex"* ]] && return 0
  done
  return 1
}

# Совпадение с lock-паттернами
matches_lock() {
  local p="$1"
  [[ $EXCL_LOCKS == false ]] && return 1
  for pat in "${LOCK_PATTERNS[@]}"; do
    case "$p" in $pat|*/$pat) return 0;; esac
  done
  return 1
}

# Дополнительные glob-исключения (например *.map)
matches_extra_glob() {
  local p="$1"
  for pat in "${EXTRA_GLOBS[@]:-}"; do
    case "$p" in $pat|*/$pat) return 0;; esac
  done
  return 1
}

# Быстрая проверка «бинарный ли файл»
is_binary() { grep -Iq . -- "$1" || return 0; return 1; }

# -------- Разбор аргументов --------
while (( "$#" )); do
  case "$1" in
    -o|--out) OUT="$2"; shift 2;;
    -d|--dirs) IFS=',' read -r -a DIRS <<< "$2"; shift 2;;
    -R|--no-root) INCLUDE_ROOT=false; shift;;
    -e|--allow-ext) IFS=',' read -r -a ALLOW_EXT <<< "$2"; shift 2;;
    -a|--add-ext) IFS=',' read -r -a add_ext <<< "$2"; ALLOW_EXT+=("${add_ext[@]}"); shift 2;;
    -x|--exclude-dirs) IFS=',' read -r -a add_ex <<< "$2"; EXCLUDES+=("${add_ex[@]}"); shift 2;;
    -X|--only-excludes) IFS=',' read -r -a EXCLUDES <<< "$2"; shift 2;;
    -g|--exclude-glob) IFS=',' read -r -a EXTRA_GLOBS <<< "$2"; shift 2;;
    -L|--no-locks) EXCL_LOCKS=false; shift;;
    -p|--per-file-max) PER_FILE_MAX="$2"; shift 2;;
    -t|--total-max) TOTAL_MAX="$2"; shift 2;;
    -h|--help) usage; exit 0;;
    --) shift; break;;
    -*)
      echo "Unknown option: $1" >&2; usage; exit 1;;
    *) echo "Unexpected arg: $1" >&2; usage; exit 1;;
  esac
done

# -------- Сбор кандидатов --------
TMP="$(mktemp)"; : > "$TMP"

# (1) Корень — только файлы верхнего уровня, если включён
if [[ "$INCLUDE_ROOT" == true ]]; then
  find . -maxdepth 1 -type f -print >> "$TMP" || true
fi

# (2) Рекурсивно обходим указанные каталоги (кроме явного ".")
for d in "${DIRS[@]}"; do
  [[ "$d" == "." ]] && continue
  [[ -d "$d" ]] && find "$d" -type f -print >> "$TMP" || true
done

# Убираем дубли
sort -u "$TMP" -o "$TMP"

# -------- Склейка дампа --------
: > "$OUT"
total=0

while IFS= read -r f; do
  [[ -f "$f" ]] || continue

  # Не включаем сам OUT и любые предыдущие project-dump*.md
  if [[ "$f" == "$OUT" ]] || [[ "$(basename "$f")" == project-dump*.md ]]; then
    continue
  fi

  # Фильтры
  is_excluded_path "$f" && continue
  matches_extra_glob "$f" && continue
  matches_lock "$f" && continue
  has_ext "$f" || has_allowed_basename "$f" || continue
  is_binary "$f" && continue

  # Лимиты
  size=$(wc -c < "$f" | tr -d ' ')
  (( total >= TOTAL_MAX )) && break

  # Маппинг языка подсветки
  ext="${f##*.}"
  case "$ext" in
    vue) lang="vue" ;; ts) lang="ts" ;; tsx) lang="tsx" ;;
    js) lang="js" ;; mjs|cjs) lang="javascript" ;;
    json) lang="json" ;; css|postcss) lang="$ext" ;;
    scss|sass|less) lang="$ext" ;; md|markdown) lang="md" ;;
    yaml|yml) lang="yaml" ;; html) lang="html" ;;
    sh|bash) lang="bash" ;; env|conf|ini|txt) lang="" ;;
    *) lang="" ;;
  esac

  # Заголовок + открытие блока
  printf '## %s\n\n' "$f" >> "$OUT"
  printf '```%s\n' "$lang" >> "$OUT"

  # Вставка файла (или усечённая версия)
  if (( size > PER_FILE_MAX )); then
    head -c "$PER_FILE_MAX" -- "$f" >> "$OUT" || true
    printf '\n```\n\n> ⛔ File truncated: original %d bytes, kept %d bytes.\n\n' "$size" "$PER_FILE_MAX" >> "$OUT"
    (( total += PER_FILE_MAX ))
  else
    cat -- "$f" >> "$OUT"
    printf '\n```\n\n' >> "$OUT"
    (( total += size ))
  fi
done < "$TMP"

rm -f "$TMP"
printf 'Done: %s (≈%d bytes)\n' "$OUT" "$total"
