// Описание операций: по нему сервер решает, как исполнять вызов, и из него же собирается GET /v2/help.
// kind: action — действие персонажа (встаёт в его очередь), query — чтение, control — управление очередью и сервером.
// Проверку аргументов делает мод; здесь — только описание для бота.

export const API = {
  help: { kind: 'query', agent: false, summary: 'Это описание.' },

  // ── Действия ──
  walk_to: {
    kind: 'action',
    summary: 'Идти в точку или к объекту. Путь ищет игра; персонаж идёт сам, шаг каждый тик. Без повторов и обходов: ' +
      'действие сразу завершается с причиной no_path (пути нет), stuck (упёрся, нет продвижения дольше секунды), ' +
      'off_path (снесло с пути дальше 2 клеток), damaged (получил урон). Обход врагов и промежуточные точки — твоё решение.',
    params: {
      x: 'число — точка назначения (вместе с y)', y: 'число',
      target: 'объект вместо точки: {unit} или {x, y, name?}',
      distance: 'число — на каком расстоянии от цели остановиться; по умолчанию 0 для точки (точность около 0,25 клетки) и 2 для объекта',
      stop_on_damage: 'false — не прерывать ходьбу при уроне (по умолчанию прерывает)',
      resolution: 'целое -2…3 — мелкость сетки поиска пути; 0 — клетка, 1 — полклетки (проходы между манипуляторами), по умолчанию 0',
    },
    result: '{position, walked — пройдено клеток, straight — по прямой от старта до цели, path_length — длина найденного пути, left — осталось до цели}',
    example: { x: 12.5, y: -30.5 },
  },
  wait: {
    kind: 'action',
    summary: 'Ждать N тиков (60 тиков — секунда) или до условия из закрытого списка. Занимает очередь: следующее действие начнётся после.',
    params: {
      ticks: 'целое — сколько тиков ждать',
      until: '"craft_empty" (очередь ручного крафта пуста) или "has_item" (в инвентаре есть item в количестве count)',
      item: 'строка — для has_item', count: 'целое — для has_item, по умолчанию 1',
      max_ticks: 'целое — предел ожидания условия; по истечении ошибка timeout',
    },
    result: '{waited — тиков, met — условие выполнено}',
    example: { until: 'has_item', item: 'iron-gear-wheel', count: 10, max_ticks: 600 },
  },
  say: {
    kind: 'action', instant: true,
    summary: 'Сообщение в игровой чат: его видят люди в игре и остальные боты (событие chat).',
    params: { text: 'строка' },
    result: '{sent}',
    example: { text: 'Иду чинить стену на севере' },
  },

  mine: {
    kind: 'action',
    summary: 'Добывать руками ресурс, дерево, камень или снять постройку в инвентарь (с её содержимым). Время добычи считает игра. ' +
      'Дальность: ресурс — 2,7 клетки, остальное — 10. Призрак снимается сразу.',
    params: {
      target: 'одна цель: {unit} или {x, y, name?}',
      count: 'целое — для ресурса: сколько единиц добыть (по умолчанию 1); дерево, камень и постройка снимаются целиком',
      targets: 'или список целей (у цели может быть свой count)',
      marked: 'или true — всё помеченное на снос в area или в плане plan',
      area: '{x1, y1, x2, y2} — для marked', plan: 'имя плана — для marked',
      approach: 'true — самому обходить цели вне досягаемости (ближайшая следующей)',
    },
    result: 'одна цель: {name, gained — сколько предметов прибавилось в инвентаре, gone — объект исчез, amount_left}; список: отчёт {done, skipped, left, total, items: [...]}',
    example: { target: { x: 25.5, y: -19.5 }, count: 10 },
  },
  craft: {
    kind: 'action', instant: true,
    summary: 'Ручной крафт: поставить рецепт в очередь крафта персонажа. Тело не занимает — можно идти и строить. ' +
      'Об окончании всей очереди приходит событие craft_done; дождаться в очереди действий — wait с until: "craft_empty".',
    params: { recipe: 'имя рецепта', item: 'или имя предмета (берётся открытый рецепт ручного крафта)', count: 'целое, по умолчанию 1' },
    result: '{recipe, queued — сколько поставлено (может быть меньше requested, если не хватило ингредиентов), requested, queue_size}',
    example: { item: 'iron-gear-wheel', count: 10 },
  },
  cancel_craft: {
    kind: 'action', instant: true,
    summary: 'Отменить ручной крафт: позицию очереди (index, count) или всю очередь. Ингредиенты возвращаются в инвентарь.',
    params: { index: 'номер позиции очереди крафта (с 1); без него — вся очередь', count: 'сколько штук отменить' },
    result: '{cancelled, queue_size}', example: {},
  },
  place: {
    kind: 'action', instant: true,
    summary: 'Поставить постройки из инвентаря: одну (item, x, y) или список items. Всё в пределах дальности постройки (10 клеток) ставится сразу, в одном тике. ' +
      'Поверх совместимой постройки — быстрая замена на месте (старая возвращается в инвентарь, содержимое и настройки сохраняются); ' +
      'поверх своего призрака — призрак оживает с его настройками; такая же постройка с другим направлением — поворот.',
    params: {
      item: 'имя предмета', x: 'центр постройки', y: '', direction: 'north | east | south | west (по умолчанию north)',
      underground: 'input | output — для подземного конвейера (по умолчанию как в игре: выход, если позади по ходу стоит вход)',
      recipe: 'рецепт сборочного автомата — задать сразу', quality: 'качество предмета',
      items: 'или список таких же объектов {item, x, y, direction?, …}',
      approach: 'true — самому обходить цели вне досягаемости',
    },
    result: 'одна постройка: {name, x, y, unit, direction, replaced?, already?}; список: {done, skipped, left, total, items: [{item, x, y, ok, …}]}',
    example: { items: [{ item: 'stone-furnace', x: 10, y: 5 }, { item: 'inserter', x: 10.5, y: 6.5, direction: 'north' }] },
  },
  build_ghosts: {
    kind: 'action', instant: true,
    summary: 'Построить из инвентаря призраки (постройки и плитку): по списку, в области или по имени плана. В области заодно исполняются пометки на замену ' +
      '(быстрая замена на месте). Чего нет в инвентаре или куда нельзя поставить — попадает в отчёт с причиной.',
    params: {
      ghosts: 'список целей {unit} или {x, y}', area: 'или {x1, y1, x2, y2}', plan: 'и/или имя плана',
      upgrades: 'false — не исполнять пометки на замену в области', approach: 'true — самому обходить цели вне досягаемости',
    },
    result: '{done, skipped, left, total, items: [{name, x, y, ok, code?, message?}]}',
    example: { plan: 'smelter-1', approach: true },
  },
  transfer: {
    kind: 'action', instant: true,
    summary: 'Переложить предметы между инвентарём персонажа и объектом в досягаемости (10 клеток): один перенос или список items. ' +
      'Что, откуда и сколько — задаёшь ты; исполнитель ничего не подбирает сам.',
    params: {
      target: 'объект: {unit} или {x, y, name?}', direction: 'put — положить в объект, take — забрать из объекта',
      item: 'имя предмета (для take можно не указывать — забрать всё)', count: 'сколько (по умолчанию всё)',
      inventory: 'fuel, input, output, modules, main, ammo, burnt; по умолчанию put — как ctrl-клик (игра сама выбирает слот), take — выход машины или всё содержимое сундука',
      lane: 'left | right — полоса конвейера по ходу движения', quality: 'качество',
      items: 'или список таких же объектов', approach: 'true — самому обходить цели вне досягаемости',
    },
    result: 'один перенос: {moved, items: {предмет: количество}}; список: {done, skipped, left, total, items: [...]}',
    example: { items: [{ target: { x: 10, y: 5 }, direction: 'put', item: 'coal', count: 5 }, { target: { x: 10, y: 5 }, direction: 'take', inventory: 'output' }], approach: true },
  },
  configure: {
    kind: 'action', instant: true,
    summary: 'Настройки постройки в досягаемости — то, что игрок делает в её окне и клавишами: одна цель или список items.',
    params: {
      target: 'объект: {unit} или {x, y, name?}',
      recipe: 'рецепт сборочного автомата (false — снять); лишние ингредиенты возвращаются в инвентарь',
      direction: 'повернуть в сторону north | east | south | west', rotate: 'true — повернуть по часовой, "reverse" — против',
      filters: 'список предметов: фильтры манипулятора или фильтр разделителя', filter_mode: 'whitelist | blacklist',
      input_priority: 'left | right | none — разделитель', output_priority: 'left | right | none — разделитель',
      stack_size: 'ограничение захвата манипулятора', bar: 'сколько слотов сундука оставить открытыми (false — снять ограничение)',
      station: 'имя станции', trains_limit: 'предел поездов станции (false — снять)',
      control: 'настройки логики: объект полей управляющего поведения (circuit_enable_disable, circuit_condition, …)',
      wire: '{to: цель, type: red | green | copper, disconnect?} — провод между двумя объектами в досягаемости',
      copy_from: 'цель — скопировать настройки с другой постройки (как shift-клики)',
      items: 'или список {target, …настройки}', approach: 'true — самому обходить цели вне досягаемости',
    },
    result: '{name, x, y, unit, direction, recipe?, …}',
    example: { target: { x: 4, y: 0 }, recipe: 'iron-gear-wheel' },
  },
  research: {
    kind: 'action', instant: true,
    summary: 'Очередь исследований команды: добавить в конец, убрать, задать порядок целиком.',
    params: { add: 'имя или список имён технологий', remove: 'имя или список', set: 'список — новая очередь целиком' },
    result: '{queue, current, skipped: [{name, reason}]}',
    example: { add: ['logistics-2', 'steel-axe'] },
  },

  // ── Управление очередью ──
  act: {
    kind: 'control', write: true,
    summary: 'Поставить в очередь несколько действий одним запросом. Действия исполняются по порядку; следующее начинается ' +
      'в том же тике, в котором закончилось предыдущее. Ответ — итог каждого действия.',
    params: {
      actions: 'список действий: {type: "<имя действия>", …его параметры, on_fail?: "stop" | "continue", cancel_if_silent_s?, immediate?}. ' +
        'on_fail: stop (по умолчанию) — при неудаче остаток очереди отменяется; continue — очередь идёт дальше. ' +
        'cancel_if_silent_s — отменить действие, если от тебя нет запросов дольше стольких секунд. ' +
        'immediate: true — мгновенное действие исполняется сейчас, не дожидаясь очереди (с места, где персонаж сейчас)',
      replace: 'true — сначала очистить очередь (текущее действие отменяется)',
    },
    result: '{actions: [{action_id, action, state: done | failed | cancelled | running, result | error}], running}',
    example: { actions: [{ type: 'walk_to', x: 10, y: 5 }, { type: 'say', text: 'на месте' }] },
  },
  wait_action: {
    kind: 'control',
    summary: 'Дождаться завершения действий, поставленных раньше (после wait: false или истечения срока ожидания).',
    params: { action_id: 'номер действия', action_ids: 'или список номеров', wait_s: 'сколько ждать, по умолчанию 30' },
    result: 'как у act',
    example: { action_id: 17, wait_s: 60 },
  },
  cancel: {
    kind: 'control', write: true,
    summary: 'Отменить текущее действие (или действие action_id из очереди). Остальная очередь продолжается. Срабатывает в том же тике.',
    params: { action_id: 'номер действия; без него — текущее' },
    result: '{cancelled — номер отменённого или null, queue_length}',
    example: {},
  },
  clear: {
    kind: 'control', write: true,
    summary: 'Очистить очередь целиком вместе с текущим действием.',
    params: {},
    result: '{cancelled — сколько действий отменено}',
    example: {},
  },
  queue: {
    kind: 'query',
    summary: 'Очередь действий своего персонажа.',
    params: {},
    result: '{queue: [{action_id, action, state: running | queued, progress?}]}',
    example: {},
  },

  // ── Наблюдение ──
  status: {
    kind: 'query',
    summary: 'Свой персонаж: позиция, здоровье, инвентарь, экипировка, очередь крафта, очередь действий, дальности.',
    params: {},
    result: '{name, position, health, inventory: {предмет: количество}, free_slots, guns, ammo, armor, crafting, queue, reach: {build, interact, resource}, tick, paused}',
    example: {},
  },
  agents: {
    kind: 'query', agent: false,
    summary: 'Все боты: имя, жив ли, позиция, здоровье, текущее действие, длина очереди.',
    params: {},
    result: '{agents: [{name, alive, position, health, action, queue}]}',
    example: {},
  },
  events: {
    kind: 'query',
    summary: 'Журнал событий: свои и командные события с номером больше since. Если их нет — ждёт до wait_s и отвечает сразу при появлении. ' +
      'Первый вызов без since возвращает текущий номер seq; дальше передавай since = seq из прошлого ответа.',
    params: {
      since: 'номер последнего виденного события',
      wait_s: 'сколько секунд ждать новых событий (до 60), по умолчанию 0',
      types: 'список типов событий — получать только их',
      limit: 'не больше стольких событий за ответ (по умолчанию 200)',
    },
    result: '{events: [{seq, type, tick, agent?, …}], seq, more?, missed? — часть событий до since уже вытеснена из журнала}',
    example: { since: 1200, wait_s: 30, types: ['agent_damaged', 'entity_died', 'chat'] },
  },
  ping: {
    kind: 'query', agent: false,
    summary: 'Версия мода, список операций и действий, текущий тик, пауза.',
    params: {}, result: '{mod, version, api, tick, paused, ops, actions}', example: {},
  },
  busy: {
    kind: 'query', agent: false,
    summary: 'Сколько ботов заняты (непустая очередь действий или ручного крафта) и стоит ли игра на паузе.',
    params: {}, result: '{busy, paused}', example: {},
  },

  // ── Администратору ──
  metrics: { kind: 'control', admin: true, summary: 'Счётчики вызовов и времени ответа по операциям.', params: {}, result: '{ops, errors, journal}', example: {} },
  pause_if_idle: {
    kind: 'control', admin: true,
    summary: 'Правило паузы одним шагом: пауза, если в игре нет людей, людей нет в голосовом канале и все очереди пусты; иначе игра идёт.',
    params: { voice: 'есть ли люди в голосовом канале', ignore: 'имена игроков, которых не считать людьми (клиент-камера)' },
    result: '{paused, changed, humans, busy}', example: { voice: false, ignore: ['camera'] },
  },
};

export const EVENT_TYPES = {
  action_done: 'своё действие завершено: {action_id, action, ok, result | error, ticks}',
  queue_empty: 'своя очередь действий опустела',
  craft_done: 'очередь ручного крафта опустела',
  agent_damaged: 'свой персонаж получил урон: {health, damage, by, position}; не чаще раза в 5 секунд',
  agent_died: 'свой персонаж погиб: {position — место трупа, by, respawn_position}; новый персонаж — у точки возрождения, с пустым инвентарём',
  entity_damaged: 'постройка команды повреждена: {name, unit, position, health, max_health, by}; по одному объекту не чаще раза в 5 секунд',
  entity_died: 'постройка команды разрушена: {name, unit, position, by, by_force}',
  research_finished: 'исследование завершено: {name, level}',
  chat: 'сообщение в игровом чате: {from, text, bot? — от бота}',
  player_joined: 'человек зашёл в игру: {name}',
  player_left: 'человек вышел: {name}',
  agent_created: 'появился новый бот: {name}',
};

export const ERROR_CODES = {
  bad_request: 'неверные аргументы (HTTP 400)',
  unauthorized: 'нет или неверный токен (HTTP 401)',
  forbidden: 'операция не для этого токена (HTTP 403)',
  unknown_op: 'нет такой операции (HTTP 404)',
  game_unavailable: 'сервер игры недоступен (HTTP 503)',
  out_of_reach: 'цель дальше, чем дотягивается персонаж',
  no_item: 'нет предмета в инвентаре',
  no_space: 'нет свободного места',
  blocked: 'место занято или постройка там невозможна',
  not_found: 'объекта нет',
  not_visible: 'место не открыто на карте или скрыто туманом войны',
  no_path: 'пути нет',
  stuck: 'упёрся при ходьбе',
  off_path: 'снесло с пути',
  damaged: 'действие прервано уроном',
  busy: 'поисковик пути игры занят, повтори',
  dead: 'персонаж погиб во время действия',
  cancelled: 'действие отменено (ботом, остановкой очереди или сторожем cancel_if_silent_s)',
  timeout: 'условие ожидания не выполнилось за отведённое время',
  not_allowed: 'игра этого не разрешает (рецепт не исследован, чужая команда и т. п.)',
  internal: 'внутренняя ошибка — сообщи разработчику',
};

export function helpDocument(info) {
  const ops = {};
  for (const [name, s] of Object.entries(API)) {
    if (s.admin) continue;
    ops[name] = { kind: s.kind, instant: s.instant || undefined, summary: s.summary, params: s.params, result: s.result, example: s.example };
  }
  return {
    about: 'Управление персонажем-ботом в Factorio. Каждый вызов — POST /v2/<операция> с JSON-телом и заголовком ' +
      'Authorization: Bearer <токен>; ответ — JSON с полем ok. Токен привязан к одному персонажу. ' +
      'Персонаж действует только так, как может игрок: дальность, инвентарь, рецепты, свободное место проверяются.',
    conventions: {
      call: "curl -s -X POST $FACTORIO_API/v2/walk_to -H \"Authorization: Bearer $FACTORIO_TOKEN\" -d '{\"x\": 10, \"y\": 5}'",
      response: 'Успех: {ok: true, …поля результата}. Отказ: {ok: false, error: {code, message, data}}. Отказ игры (не дотянулся, нет предмета, упёрся) ' +
        'приходит с HTTP 200; HTTP 4xx/5xx — только ошибки запроса, доступа и связи с игрой.',
      actions: 'Действие (kind: action) встаёт в очередь персонажа. По умолчанию сервер сам ждёт его завершения и возвращает итог (wait: true, до wait_s секунд, ' +
        'по умолчанию 30, не больше 110). С wait: false или по истечении срока ответ — {ok: true, running: true, action_id}; действие продолжает исполняться, ' +
        'итог — событием action_done или вызовом wait_action. Обрыв соединения действие не отменяет.',
      instant: 'Мгновенные действия (instant) исполняются в том же тике, если очередь пуста; иначе встают в очередь по порядку. ' +
        'Несколько действий подряд — одним запросом act.',
      idempotency: 'К пишущему запросу можно приложить свой "id" (строка). Повтор с тем же id вернёт сохранённый ответ и ничего не выполнит второй раз ' +
        '(для повтора после потерянного ответа). Запросы с разными id или без id исполняются каждый.',
      targets: 'Объект мира задаётся как {unit: номер} (поле unit из ответов) или {x, y, name?} — объект в этой точке.',
      coordinates: 'x растёт на восток, y — на юг. Клетка (tile) с углом (10, 5) имеет центр (10.5, 5.5). 60 тиков — секунда игры.',
      events: 'О происходящем узнавай из events (долгий опрос из параллельного скрипта), а не опросом мира.',
      pause: 'Игра стоит на паузе, когда в ней нет людей и у всех ботов пустые очереди; поставленное действие само снимает паузу, чтение — нет.',
    },
    operations: ops,
    event_types: EVENT_TYPES,
    error_codes: ERROR_CODES,
    mod: info ? { version: info.version, tick: info.tick } : undefined,
  };
}
