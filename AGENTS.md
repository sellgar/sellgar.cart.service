# @service/cart

Cart owns carts, quantities and its participation in Order checkout. Source: workspace commerce RFC.

- Store owns prices and inventory; Product owns catalog names/status/images; Shop owns shop names.
- Keep exactly the required projection fields. No catalog history or inventory movements.
- ownerUuid comes from verified internal session context; no owner discriminator or public user/session lookup.
- Reads use local projections. Add/setQuantity and checkout preparation refresh the record's Store/Shop/Product projections from owners before checking availability. Recovery commits independently of a rejected command so an observed archive remains visible. Quantity commands additionally verify authoritative Store stock using the full snapshot; a sale conflict refreshes the projection before rejection. Checkout reserves belong to Order/Store.
- Архивные/отключённые и скрытые строки сохраняются с причиной и возможностью удаления, но исключаются из itemsTotal и оформления. Не создавать отдельную систему сообщений вместо существующих причин недоступности.
- Explicit migrations; synchronize is disabled.
- Atomic commands/outbox, inbox source version checks, recover gaps from owners.
- Use @sellgar/outbox from library/sellgar.outbox.library for writer, repository, relay, retries, timeouts and metrics. AppModule registers it once with CART_OUTBOX_OPTIONS; CartEventsRepository only builds domain events and passes the current EntityManager to OutboxWriter. Do not recreate local relay/repository implementations. yarn build builds the workspace library first.
- Outbox claim orders each (aggregateType, aggregateUuid) by PostgreSQL aggregate_version, preserving bigint precision. Any lower unpublished version (including backoff, processing or dead) blocks successors; other aggregates continue. Relay drains successive claims within the total batchSize. Verify with yarn test:integration outbox-ordering.
- Closure locks owner, cart mutation locks cart, checkout locks owner then cart. Preserve cancellation tombstones.
- Tests use only random PostgreSQL schemas; never reset public data.
- Two RMQ microservices share one Nest context; operational HTTP /health on 8080 only.
- Tests: yarn build; yarn test --runInBand; yarn test:integration; yarn test:smoke.

- Identity integration consumes identity.owner.closed.v1 through the durable event queue and delegates to existing closeOwner. ACK follows commit; eventUuid is the internal deduplication key. Cart does not issue/inspect sessions or determine guest/account types. Provision the consumer binding before the Identity lifecycle publisher.

## Деплой

- Исходники и Yarn root находятся в `code/`; команды выполнять оттуда.
- Dockerfile, `.github/` CI и `helm/` находятся в корне. Рабочая ветка `development`, выпуск `master`.
- CI использует общий reusable workflow: unit → build → publish → migrate → deploy. Ошибка unit блокирует build; ошибка migrate блокирует deploy; управление приложением принадлежит Helm CI, платформой — Argo CD.
- ConfigMap монтирует `/app/.env`, credentials поступают только из Secret refs. Одна реплика, внутренний порт 8080.
- Явные миграции запускает Job перед Deployment; synchronize отключён.

- Текущая цена принадлежит accounting_record_snapshot; store_offer_snapshot цену не хранит. Cart читает цену только по recordUuid.
- Store Product schemaVersion=3 содержит records[].currentPrice; legacy v2 переводится отдельным адаптером из offer.currentPrice. Inventory остаётся v2.
- Авторитетный Store snapshot равной версии может согласовать price UUID/value/currency после миграции. События равной/старой версии цену не меняют; повтор одинакового snapshot не создаёт уведомления.

## Контракт CI/CD

- Отдельный Docker target `tests` и job `unit` обязательны; сборка и деплой зависят от успешных юнит-тестов.
- Есть отдельный `migration` image и job `migrate`; unit запускается до build, migrate — после publish.
- CI/CD и конфигурация описаны в разделе «CI и доставка» README. Python/smoke wrappers удалены; команды Helm/kubectl видны в общих workflows.

- Самостоятельные списки используют @sellgar/pagination: limit/nextToken, ответ items/meta, без totalRows и COUNT всей выборки. HMAC-ключ приходит только из Secret. Подробности — README. Вложенные коллекции и снимки не пагинировать.
