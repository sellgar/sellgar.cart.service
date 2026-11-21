# sellgar.cart.service

Cart Service для корзин отдельных магазинов единой сети. Один активный Cart на
`(ownerUuid, shopUuid)`. Владелец передается одним UUID из проверенного контекста
Identity. Тип владельца, контакты пользователя, цены и остатки в позициях не дублируются.

## Запуск

NestJS/RMQ, PostgreSQL, две очереди в одном Nest-контексте; внутренний HTTP `/health` на 8080 проверяет PostgreSQL и оба RMQ consumer.
Версии runtime/dependencies соответствуют действующему Store Service. Структура:
`code/src/api/v1/cart/{controller,service,repository,entity,model}`, `code/src/integration`,
`code/src/database/migrations`. Схема изменяется только явными миграциями.

```bash
cp .env.example .env
# Заполнить подключения PostgreSQL/RabbitMQ; создать отдельную БД cart_srv.
yarn install --immutable
yarn migration:run
yarn build
yarn start:prod
```

`CART_CURRENCY_CODE` обязателен. Пример локальной конфигурации использует RUB;
сервис запрещает операции покупки позиций с другой валютой. `CART_DATABASE_SCHEMA`
по умолчанию `public`, synchronize всегда выключен. `CART_BOOTSTRAP_ON_START=true`
запускает первоначальную загрузку. RMQ health — `cart.health`.

## Модель: 14 таблиц

| Собственные | Проекции | Служебные |
|---|---|---|
| carts | shop_snapshot | command_request |
| cart_items | product_snapshot | inbox_event |
| cart_checkouts | variant_snapshot | outbox_event |
| | store_product_snapshot | sync_issue |
| | store_offer_snapshot | |
| | accounting_record_snapshot | |
| | record_inventory_snapshot | |

Точный набор столбцов задают модели и миграция `CreateCart1794830000000`, согласованная
с commerce RFC workspace. Суммы и сообщения недоступности вычисляются при чтении.
Деньги — numeric(12,2)/decimal string, вычисления — целые минимальные единицы через
BigInt. Версии собственных корзин/позиций и outbox — bigint/string без Number conversion.
Версии источников — integer. Техническая таблица `migrations` принадлежит TypeORM.

## Внутренние RMQ-команды

Все команды используют `{ cmd: pattern }`. Указанный ownerUuid — вход доверенного
gateway/Order/session flow, а не публично выбираемое поле пользователя. Сервис
не предоставляет HTTP endpoint для передачи произвольного владельца. Gateway обязан
получить ownerUuid от Identity и проверить действующую сессию. Сравнение владельца,
магазина, версий и блокировок выполняется также внутри Cart.

| Pattern | Payload |
|---|---|
| cart.get | ownerUuid, shopUuid |
| cart.item.add | idempotencyKey, ownerUuid, shopUuid, recordUuid, quantity |
| cart.item.setQuantity | idempotencyKey, ownerUuid, shopUuid, recordUuid, quantity, expectedItemVersion |
| cart.item.remove | idempotencyKey, ownerUuid, shopUuid, recordUuid, expectedItemVersion |
| cart.checkout.prepare | idempotencyKey, ownerUuid, shopUuid, cartUuid, checkoutUuid, items[] |
| cart.checkout.cancel | idempotencyKey, ownerUuid, shopUuid, cartUuid, checkoutUuid |
| cart.owner.close | idempotencyKey, ownerUuid |
| cart.health | {} |

`idempotencyKey` — UUID одной операции. Повтор того же запроса сохраняет ключ,
новая операция получает новый UUID. Это техническая защита от повторного выполнения.
`expectedItemVersion` — версия конкретной позиции Cart, положительная десятичная
строка из `items[].version`, а не версия всей корзины. Элемент подготовки:
`{ recordUuid, quantity, expectedItemVersion }`; массив непустой, UUID не повторяются.
Подготавливаются выбранные целые позиции, их количество должно совпасть с корзиной.
Результат изменяющей команды минимален; актуальное представление читается отдельно.

- `get` создает пустую корзину при первом обращении, сохраняя ее UUID после очистки.
- Повторное добавление увеличивает существующее количество. Add/set проверяют текущий
  доступный остаток у Store; чтение корзины сетевых запросов к владельцам не делает.
- В новой записи quantity не больше доступного; уменьшение запрошенного значения также
  должно удовлетворять текущему остатку. Уже возникший из-за изменения Store дефицит
  сохраняется до решения покупателя. Строку можно удалить без доступного Store.
- Идентификатор команды сохраняет исходный hash и результат атомарно с изменением/outbox.
  Иной владелец или запрос с тем же ID отклоняется; retry не увеличивает количество снова.
- Row version берется из продолжающейся Cart.version. Другие позиции не теряют свою
  версию; удаление и повторное добавление не допускают ABA-перезаписи.
- Блокируются только выбранные строки. Неизвестный исход не снимает блокировку по TTL.
- Событие `order.checkout.completed` поступает от Order после сохранения успеха заказа
  и всех резервов. Удаляются только закрепленные строки. `cancel` вызывается после подтвержденной
  компенсации и сохраняет отмену даже до первой подготовки. Поздний prepare не оживляет
  отмененное оформление. Сам Order и резервы здесь не реализуются.
- Identity/session flow вызывает `owner.close` при входе гостя или истечении его сессии,
  закрывая все магазины прежнего ownerUuid. Завершение сессии аккаунта не закрывает его Cart.
  Закрытие сериализуется с изменениями владельца. Маркер закрытого ownerUuid хранится
  в результате `cart.owner.close` даже при отсутствии корзин; удалять его общей очисткой
  command_request нельзя. Завершение старого checkout разрешено и не восстанавливает гостя.

## Административный API

Отдельный controller обслуживает только доверенный admin gateway:

| Команда | Payload |
|---|---|
| cart.admin.getAll | shopUuid?, ownerUuid?, status? (active/closed), limit=50, offset=0 |
| cart.admin.getByUuid | uuid |
| cart.admin.item.add | cartUuid, idempotencyKey, recordUuid, quantity |
| cart.admin.item.setQuantity | cartUuid, idempotencyKey, recordUuid, quantity, expectedItemVersion |
| cart.admin.item.remove | cartUuid, idempotencyKey, recordUuid, expectedItemVersion |

Список возвращает `{ data, meta: { totalRows, limit, offset } }` с UUID, владельцем,
магазином/названием, версией, числом позиций и createdAt/updatedAt/closedAt.
Фильтры пересекаются; без status возвращаются обе группы. limit 1–100, offset >= 0;
порядок updated_at DESC, uuid ASC. Карточка — обычное представление плюс timestamps.
Чтение использует локальные проекции в REPEATABLE READ и ничего не создает.
Закрытые корзины видны администратору; их разрешения изменения выключены.

Изменения работают только с существующим cartUuid. Cart сам определяет его
ownerUuid/shopUuid и повторно проверяет UUID/состояние в транзакции под теми же
блокировками, что и покупательские команды. Используется общая логика add/set/remove:
идемпотентность, версия позиции, остаток Store, ограничения магазина и checkout lock.
UUID целевой корзины включен в hash намерения. Закрытые/неизвестные корзины не
восстанавливаются и не создаются. Внутренний admin RPC не предназначен для
публичного customer gateway. HTTP/session boundary находится в admin gateway.

## Завершение оформления от Order

Подписка на `order.checkout.completed` в общей event exchange, durable Cart event queue.
Это контракт будущего Order Service; его producer пока не реализован.

```json
{
  "eventUuid": "UUID события, стабильный при повторной доставке",
  "producer": "order_srv",
  "eventType": "order.checkout.completed",
  "schemaVersion": 1,
  "aggregateType": "checkout",
  "aggregateUuid": "UUID оформления Order",
  "aggregateVersion": 3,
  "occurredAt": "2026-11-16T10:00:00.000Z",
  "payload": {
    "ownerUuid": "UUID исходного владельца",
    "shopUuid": "UUID магазина",
    "cartUuid": "UUID исходной корзины"
  }
}
```

Все поля UUID должны содержать валидные UUID. aggregateVersion — положительное целое
значение версии оформления у Order; 3 в примере не фиксирует конкретный переход.
Cart принимает терминальный факт, поэтому не требует предыдущих событий оформления.
Order публикует его через outbox только после подтверждения заказа и всех резервов.

Обработчик использует eventUuid как ключ надежной квитанции в command_request;
квитанция, завершение cart_checkouts, удаление выбранных строк и Cart outbox атомарны.
Отдельной копии receipt в inbox_event для этого события нет. Повтор события и новый
идентификатор того же терминального результата не меняют корзину повторно.
ACK отправляется после commit. Ошибки контракта, неверные ссылки и конфликт результата
идут в dead-letter queue; временные сбои возвращаются в очередь. Ошибка не снимает
блокировку. При успешном завершении закрытой гостевой корзины меняется только она.
Команды `cart.checkout.complete` нет; завершение нельзя вызвать через Cart RPC.

## Представление

Cart возвращает магазин с названием, позиции с productName/variantName, артикулом,
уточнениями, основным imageUuid, ценой/валютой, количеством и доступным остатком.
Есть отдельные canCheckout/canOpenProduct/canIncrease/canDecrease/canRemove и reasons.
Unavailable rows сохраняются через LEFT JOIN; отсутствие проекции — «Данные уточняются».

- `showing=false`: «Временно недоступен», покупка запрещена, строка сохраняется.
- `disabled/archived` Store или архивирование Product/Variant: «Товар больше не продается».
  Это сообщение имеет приоритет над скрытием/остатком; удаление доступно вне checkout lock.
- Нулевой остаток: «Нет в наличии». Количество покупателя автоматически не уменьшается.
- При возврате одного условия проверяются все остальные. Нулевая цена допустима;
  отсутствие цены не преобразуется в ноль.
- `itemsTotal` — сумма товаров всей корзины с известными ценами в общей валюте, включая
  сохраненные недоступные позиции. Если цена/валюта не позволяют определить общую сумму,
  возвращается null. Это не сумма выбранного оформления с доставкой: ее определяет Order.
- Текущие данные корзины не заменяют подтверждение цены. Клиент передает показанные
  priceUuid в Order; окончательная проверка цены/наличия и резерв — у владельцев.

## Проекции и восстановление

Подписки: Store `store.product.created/updated/archived`, `store.inventory.updated`
(schemaVersion=2/3); Product `product.created/updated` (producer=product_srv,
schemaVersion=3); Shop `shop.created/updated` (schemaVersion=3).
Принимаются оба используемых владельцами имени aggregateId/aggregateUuid, внутреннее
имя — aggregateUuid. Проверяются producer, schema, identity, версия и связи payload.

- Store Product обновляет предложения/записи/уточнения одной транзакцией по своей версии.
- Inventory имеет независимую версию. Вложенный старый остаток не затирает свежий,
  а свежий остаток может примениться из снимка с прежней версией Store Product.
- Product обновляет имена/статусы вариантов и одно основное изображение. Порядок
  уточнений сохраняется; копии полной галереи, каталога и истории цен отсутствуют.
- Разрыв версий/недостающий родитель сохраняется в inbox/sync_issue. ACK происходит
  после commit. Worker восстанавливает authoritative snapshot, разрешает покрытые
  проблемы и не откатывает более новые данные. Постоянного опроса здоровых источников нет.
- Bootstrap загружает магазины постранично и Store Products, включая скрытые/архивные,
  с каталоговыми зависимостями. Recovery inventory использует новый Store read pattern
  `store.product.getByRecordUuid`. Bootstrap и synchronize доступны только внутри сервиса;
  внешних RMQ-команд для управления проекциями нет.
- Неподдерживаемый/поврежденный контракт отправляется в durable dead-letter queue:
  `<eventQueue>.dead`, exchange `<eventQueue>.dead.exchange`. Бесконечного requeue poison нет.

Исходящие события: `cart.created`, `cart.updated`, `cart.closed`, `cart.projection.updated`.
Изменение и outbox фиксируются вместе. Relay соответствует протоколу действующего Store:
claim/retry, timeout публикации и обработка зависшего processing. Общая outbox library
пока использует другую схему (aggregate_id/int и unique aggregate version); Cart сохраняет
согласованную схему aggregate_uuid/bigint и допускает отдельные invalidation events.

События состава содержат cartUuid/ownerUuid/shopUuid/version. Projection invalidation
содержит source и server-only targets `[{ cartUuid, ownerUuid, shopUuid }]`.
Gateway должен разделить их по приватным аудиториям. Нельзя переслать targets в общий
сокетный канал. Notification публикуется после применения проекции и является сигналом
перечитать Cart; дедупликация — по eventUuid. Версия входящего Store Product сама по себе
не определяет свежесть вложенного inventory. Снимок возвращает версии фактически
использованных источников; неизменная Cart.version не отменяет обновление представления.

## Границы интеграции

Identity, Client Gateway и Socket Gateway подключены для аккаунтов: проверенный
ownerUuid, защищенные HTTP-команды и приватная durable доставка/replay. Гостевая
сессия пока не реализована по явному выбору пользователя. UI/providers остаются
отдельной задачей; контракты описаны в README соответствующих gateway.
Контакты пользователя не проецируются; нет Type discriminator, фиктивных аккаунтов,
Order/Payment orchestration или резервов в Cart. Данные Identity/Product/Shop/Store
не записываются Cart в базы их владельцев.

## Проверки

Общая инфраструктура outbox подключена workspace-пакетом `@sellgar/outbox` из
nested submodule `code/library/sellgar.outbox.library`. AppModule регистрирует модуль
один раз с CART_OUTBOX_OPTIONS. CartEventsRepository формирует доменное событие
и передаёт текущий EntityManager в OutboxWriter; локальных relay/repository нет.
Настройки сохраняют существующие aggregate_uuid, bigint-версии строкой, envelope
aggregateUuid и отсутствие колонки producer. `yarn build` сначала собирает пакет.
Таблица и миграции принадлежат Cart. Порядок, retry, timeout и метрики изменяются
в репозитории общей библиотеки вместе с остальными её потребителями.

```bash
yarn build
yarn test --runInBand
yarn test:integration
yarn test:smoke
```

PostgreSQL integration создает/удаляет только случайную cart_test_* schema.
RMQ smoke создает собственную cart_smoke_* schema, очереди и exchange, читает настоящие
Store/Product/Shop и публикует тестовые события только в изолированный exchange.
Существующие товары/остатки/пользователи не изменяются. Тест проверяет wire DTO,
доставку событий, проекции, статусы, идемпотентность, checkout locks, owner closure,
outbox и dead-letter и удаляет свои ресурсы после завершения.

## CI и доставка

Push в `development` запускает unit → build → publish → migrate → deploy.
`unit` — обязательная job с юнит-тестами из Docker target `tests` до сборки приложения.
Если тесты или миграции не прошли, deploy не запускается.
Сборка, тесты и публикация выполняются на GitHub-hosted runners;
migrate/deploy — на общем organization runner в dev VM.
Обычная раскатка выполняется Helm с ожиданием готовности и проверкой image digest.
Argo CD продолжает управлять платформой, но не этим приложением.

Docker targets: `application`, `tests`, `migration`.
Миграционный образ запускает TypeORM CLI отдельной Kubernetes Job до раскатки приложения. В runtime приложения миграции автоматически не запускаются.

Настройки среды хранятся в `helm/dev/values.yaml`, Secret refs — в
`helm/values.app.yaml`. Версионный immutable ConfigMap монтируется через
`environmentFile`; значения credentials не передаются в GitHub-hosted jobs или Git.
Внутренний HTTP-порт — 8080, в dev одна реплика.

PR запускает unit → build без публикации и деплоя. Push в `release/*` публикует
кандидат с `release.json`; ручной production workflow из `master` принимает
`candidate-<run-number>.<attempt>`, проверяет успешный исходный CI и идентичность
дерева, продвигает те же digest без пересборки. Production ещё не подготовлен:
нужны его values, Secrets, runner и GitHub environment protections.
Откат миграций в эту схему не включён.

Общие workflows закреплены тегом `delivery-v0.7.0` в `sellgar.infrastructure`.
Порядок установки runner и передачи управления: [доставка приложений](https://github.com/sellgar/sellgar.infrastructure/blob/development/docs/application-delivery.md).

## Цены учётных записей

Store владеет ценой конкретной учётки. Проекция accounting_record_snapshot хранит price_uuid,
price_value numeric(12,2) и currency_code; Store offer цену не задаёт. Одна цена в событии
не переоценивает соседние учётки. Вход Store Product принимает v3 и старые сообщения v2
через адаптер; Inventory v2 не меняется. Миграция копирует прежнюю offer-цену к записям,
а авторитетный bootstrap согласует новые price UUID без сброса версий, корзин и количества.
