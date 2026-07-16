#!/usr/bin/env sh
set -eu

project_dir="$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)"
backup_dir="$project_dir/backups"
mkdir -p "$backup_dir"

stamp="$(date +%Y%m%d-%H%M%S)"
backup_file="/app/backups/ofiprof-crm-${stamp}.sqlite"

(
  cd "$project_dir"
  docker compose exec -T -e BACKUP_FILE="$backup_file" app node --input-type=module - <<'NODE'
import { DatabaseSync } from 'node:sqlite';

const output = process.env.BACKUP_FILE;
const escapedOutput = output.replaceAll("'", "''");
const db = new DatabaseSync('/app/data/ofiprof-crm.sqlite');
db.exec(`VACUUM INTO '${escapedOutput}'`);
db.close();
console.log(output);
NODE
)

find "$backup_dir" -type f -name 'ofiprof-crm-*.sqlite' -mtime +7 -delete
