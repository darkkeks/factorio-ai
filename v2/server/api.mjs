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
      target: 'объект вместо точки: {x, y, name?}',
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
      ticks: 'целое — сколько тиков ждать; вместе с until — предел ожидания, то же, что max_ticks',
      until: '"craft_empty" (очередь ручного крафта пуста) или "has_item" (в инвентаре есть item в количестве count)',
      item: 'строка — для has_item', count: 'целое — для has_item, по умолчанию 1',
      max_ticks: 'целое — предел ожидания условия; по истечении ошибка timeout (data.waited). Без предела wait с until ждёт, пока условие не выполнится',
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
      target: 'одна цель: {x, y, name?}',
      count: 'целое — для ресурса: сколько единиц добыть (по умолчанию 1); дерево, камень и постройка снимаются целиком',
      targets: 'или список целей (у цели может быть свой count)',
      marked: 'или true — всё помеченное на снос в area или в плане plan',
      area: '{x1, y1, x2, y2} — для marked', plan: 'имя плана — для marked',
      approach: 'true — самому обходить цели вне досягаемости (ближайшая следующей)',
    },
    result: 'одна цель: {name, gained — сколько предметов прибавилось в инвентаре, gone — объект исчез, amount_left}; список: отчёт {done, skipped, left, total, items: [...]}',
    example: { target: { x: 25.5, y: -19.5 }, count: 10 },
  },
  repair: {
    kind: 'action',
    summary: 'Чинить повреждённые постройки и транспорт своей команды ремкомплектом из инвентаря, как игрок: дальность 10 клеток, ' +
      'в темпе игры (ремкомплект даёт 2 единицы прочности за тик, стене — 4; на каждый тик уходит единица его ресурса, ресурс комплекта — 300), ' +
      'по одной цели за раз. Занимает тело. Повреждённое видно по health < max_health в inspect; о повреждении сообщает событие entity_damaged.' +
      'Кончились комплекты — no_item (в data — сколько успел починить).',
    params: {
      target: 'одна цель: {x, y, name?}',
      targets: 'или список целей',
      area: 'или {x1, y1, x2, y2} (до 64×64 клеток) — всё повреждённое своей команды в области, до 200 целей',
      approach: 'true — самому обходить цели вне досягаемости (ближайшая следующей)',
      item: 'имя ремкомплекта, по умолчанию repair-pack', quality: 'качество ремкомплекта (по умолчанию любое)',
    },
    result: 'одна цель: {name, x, y, health, max_health, repaired — сколько прочности восстановлено, ticks, tools_left — комплектов осталось, already — цель и так цела}; ' +
      'список или область: отчёт {done, skipped, left, total, items: [...]}',
    example: { area: { x1: 10, y1: -40, x2: 30, y2: -30 }, approach: true },
  },
  shoot: {
    kind: 'action', instant: true,
    summary: 'Открыть огонь из надетого оружия — как игрок, зажавший кнопку огня. Исполняется сразу, в том же тике, и не занимает очередь действий: ' +
      'стрелять можно на ходу, отступая и строя (walk_to отдельным запросом; чтобы урон не прерывал ходьбу — stop_on_damage: false). Без параметров прицел сам переходит на ближайшего к тебе врага в дальности оружия ' +
      '(кусаки, плеваки, черви, гнёзда) и так по каждому следующему, пока враги есть; темп стрельбы, расход патронов и урон считает движок. ' +
      'at {x, y} — то же, но ближайший к этой точке враг. target {x, y, name?} — прицел следует за этим врагом, ' +
      'пока тот жив; он должен быть виден вживую. Вне дальности выстрелов нет — огонь остаётся зажатым и начнётся, когда враг подойдёт или подойдёшь ты ' +
      '(в ответе range, а для target — distance и in_range). Огонь держится duration_s секунд (по умолчанию 20, не больше 120) и продлевается повторным shoot; ' +
      'раньше кончается сам, когда нет патронов ни в одном слоте, цель target убита, персонаж погиб или вызван stop_shooting. Кончились патроны в слоте — ' +
      'игра переходит на следующее оружие с патронами. Итог приходит событием shooting_done. Пока огонь зажат, игра не встаёт на паузу. ' +
      'Чтобы успеть ответить на нападение, слушай события enemies_near и agent_damaged из параллельного скрипта и держи оружие с патронами надетым (equip).',
    params: { target: 'конкретный враг {x, y, name?}', at: 'точка прицела {x, y}; без target и at — прицел на себе', slot: 'слот оружия 1…3; без него — выбранное оружие, а если в нём нет патронов — первое с патронами',
      duration_s: 'сколько секунд держать огонь (по умолчанию 20, не больше 120)' },
    result: '{shooting: true, mode: enemies | target, slot, gun, ammo, ammo_count, range, seconds, enemies_in_range, target?, distance?, in_range?}',
    example: { duration_s: 30 },
  },
  stop_shooting: {
    kind: 'action', instant: true,
    summary: 'Прекратить огонь. Исполняется сразу, не дожидаясь очереди действий.',
    params: {},
    result: '{shooting: false, reason: "stopped", killed, kills: {имя врага: число}, seconds, ammo_left, health, position}; огня не было — {shooting: false, already: true}',
    example: {},
  },
  throw: {
    kind: 'action', instant: true,
    summary: 'Бросить капсулу из инвентаря в точку — как игрок, щёлкнувший капсулой по земле: grenade, cluster-grenade, poison-capsule, slowdown-capsule, ' +
      'боевые дроны defender-capsule / distractor-capsule / destroyer-capsule (дроны-спутники летят за тобой, их число ограничено исследованиями), ' +
      'cliff-explosives (рядом с точкой должна быть скала). raw-fish — съесть и подлечиться: без at и target, при полном здоровье — not_allowed. ' +
      'Исполняется сразу, в том же тике, и не занимает очередь действий: бросать можно на ходу и стреляя. Снаряд, урон по площади и расход предмета считает движок; ' +
      'урон по площади задевает и тебя, и свои постройки. Дальность — по капсуле (в ответе range; граната 15, кластерная и defender 20, остальные 25; cliff-explosives 10): ' +
      'дальше — out_of_range с distance, подойди. Перезарядка между бросками — как у игрока (cooldown_ticks, обычно 30 тиков): брошенное раньше не отказывает, ' +
      'а летит, как только перезарядка пройдёт (в ответе done: false и next_in_ticks). count — серия из нескольких капсул в ту же точку (или в ту же цель target: ' +
      'каждая летит туда, где цель сейчас) по одной за перезарядку; итог серии — событие throw_done. Серия кончается раньше, если капсулы кончились, цель погибла, ' +
      'ты ушёл дальше дальности, пришёл новый throw (сменяет серию) или stop_throwing. target должен быть виден вживую; at — любая точка в дальности.',
    params: { item: 'имя капсулы', quality: 'качество (по умолчанию любое)', at: 'точка {x, y}', target: 'объект {x, y, name?} — бросок в него', count: 'сколько капсул подряд, 1…20 (по умолчанию 1)' },
    result: '{item, kind: throw | use-on-self | destroy-cliffs, range, cooldown_ticks, at, distance, target?, count, thrown — сколько уже брошено, done, reason? — при done: true, ' +
      'next_in_ticks? — через сколько тиков следующий бросок, left — сколько таких капсул осталось, health? — после рыбы, replaced? — номер сменённой серии}',
    example: { item: 'grenade', at: { x: 120.5, y: -40.5 }, count: 3 },
  },
  stop_throwing: {
    kind: 'action', instant: true,
    summary: 'Прервать серию бросков (throw с count). Исполняется сразу, не дожидаясь очереди действий.',
    params: {},
    result: '{throwing: false, reason: "stopped", item, thrown, count, left, health, position}; серии не было — {throwing: false, already: true}',
    example: {},
  },
  equip: {
    kind: 'action', instant: true,
    summary: 'Надеть из инвентаря оружие, патроны или броню в слоты персонажа, как в окне персонажа. Вид слота определяется предметом. ' +
      'Оружие: в slot или в первый свободный слот; занятый slot — оружие меняется местами (старое уходит в инвентарь, в ответе replaced). ' +
      'Патроны: count штук (по умолчанию все) в slot или в первый подходящий слот; патроны должны подходить оружию в том же слоте, ' +
      'в слот с другими патронами не кладутся (сначала unequip). Броня: слот один, надетая меняется местами с новой; ' +
      'если у новой меньше запас слотов инвентаря, нужно столько же свободных слотов — иначе no_space. ' +
      'Предметы, взятые в инвентарь (transfer take, добыча), игра часто надевает сама — смотри status → weapons, armor. ' +
      'Стрелять — shoot; гранаты и капсулы надевать не нужно — throw бросает их из инвентаря.',
    params: { item: 'имя оружия, патронов или брони', quality: 'качество (по умолчанию любое)', count: 'для патронов — сколько, по умолчанию все', slot: '1…3 — номер слота оружия или патронов' },
    result: '{item, kind: gun | ammo | armor, slot, moved, replaced?, already?, weapons: [{slot, gun?, ammo?, count?}], inventory_slots — для брони: размер инвентаря после}',
    example: { item: 'firearm-magazine', count: 20, slot: 1 },
  },
  unequip: {
    kind: 'action', instant: true,
    summary: 'Снять надетое оружие, патроны или броню в инвентарь. Нет свободного слота — no_space; броня с запасом слотов инвентаря ' +
      'требует столько же свободных слотов плюс один под себя (иначе лишнее высыпалось бы на землю).',
    params: { item: 'имя надетого предмета', quality: 'качество (по умолчанию любое)', count: 'для патронов — сколько, по умолчанию все из слота', slot: '1…3 — из какого слота (по умолчанию первый с таким предметом)' },
    result: '{item, kind, slot, moved, weapons?, inventory_slots?}',
    example: { item: 'pistol' },
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
    summary: 'Построить из инвентаря призраки (постройки и плитку): по списку, в области или по имени плана. В области и в плане заодно исполняются пометки ' +
      'на замену (быстрая замена на месте). Призрак поверх совместимой постройки (подземный конвейер или разделитель поверх ленты, та же постройка ' +
      'в другую сторону — в ghosts у него поле replaces) ставится быстрой заменой: сносить старое заранее не нужно, оно возвращается в инвентарь. ' +
      'Столбы из призраков соединяются медным проводом с соседними столбами, как поставленные из руки (провода из чертежа сохраняются). ' +
      'Чего нет в инвентаре или куда нельзя поставить — попадает в отчёт с причиной.',
    params: {
      ghosts: 'список целей {x, y}', area: 'или {x1, y1, x2, y2}', plan: 'и/или имя плана',
      upgrades: 'false — не исполнять пометки на замену', approach: 'true — самому обходить цели вне досягаемости',
    },
    result: '{done, skipped, left, total, items: [{name, x, y, ok, replaced?, upgrade?, code?, message?}]}',
    example: { plan: 'smelter-1', approach: true },
  },
  transfer: {
    kind: 'action', instant: true,
    summary: 'Переложить предметы между инвентарём персонажа и объектом в досягаемости (10 клеток): один перенос или список items. ' +
      'Что, откуда и сколько — задаёшь ты; исполнитель ничего не подбирает сам.',
    params: {
      target: 'объект: {x, y, name?}', direction: 'put — положить в объект, take — забрать из объекта',
      item: 'имя предмета (для take можно не указывать — забрать всё)', count: 'сколько (по умолчанию всё)',
      keep: 'для put патронов: сколько оставить в своих слотах патронов (по умолчанию 0). Патроны берутся из основного инвентаря, а при нехватке до count — из слотов патронов ' +
        '(в ответе from_ammo); без count надетые берутся, только если в инвентаре нет ни одного',
      inventory: 'fuel, input, output, modules, main, ammo, burnt, robots (слоты роботов робопорта; main у робопорта — слоты ремкомплектов), rocket (грузовой отсек ракеты в шахте: есть, когда ракета собрана; вместимость — по весу, см. inspect → rocket); по умолчанию put — как ctrl-клик (игра сама выбирает слот), take — выход машины или всё содержимое сундука',
      lane: 'left | right — полоса конвейера по ходу движения', quality: 'качество',
      items: 'или список таких же объектов', approach: 'true — самому обходить цели вне досягаемости',
    },
    result: 'один перенос: {moved, items: {предмет: количество}, from_ammo? — сколько из них взято из слотов патронов}; список: {done, skipped, left, total, items: [...]}',
    example: { items: [{ target: { x: 10, y: 5 }, direction: 'put', item: 'coal', count: 5 }, { target: { x: 10, y: 5 }, direction: 'take', inventory: 'output' }], approach: true },
  },
  configure: {
    kind: 'action', instant: true,
    summary: 'Настройки постройки в досягаемости — то, что игрок делает в её окне и клавишами: одна цель или список items. Только request_items (заявка роботам) работает и издалека — по постройке в обзоре.',
    params: {
      target: 'объект: {x, y, name?}',
      recipe: 'рецепт сборочного автомата (false — снять); лишние ингредиенты возвращаются в инвентарь',
      direction: 'повернуть в сторону north | east | south | west', rotate: 'true — повернуть по часовой, "reverse" — против',
      filters: 'список предметов: фильтры манипулятора или фильтр разделителя', filter_mode: 'whitelist | blacklist',
      input_priority: 'left | right | none — разделитель', output_priority: 'left | right | none — разделитель',
      stack_size: 'ограничение захвата манипулятора', bar: 'сколько слотов сундука оставить открытыми (false — снять ограничение)',
      station: 'имя станции', trains_limit: 'предел поездов станции (false — снять)',
      schedule: 'цель — локомотив или вагон: расписание поезда целиком, [{station, wait: [{type, ticks? | seconds?, compare?: and | or, item? | fluid?, comparator?, count?}]}]; type: time | inactivity (ticks или seconds), full, empty, not_empty, fuel_full, passenger_present, passenger_not_present, item_count | fluid_count (item | fluid, comparator, count); станции — только существующие (см. trains); false — очистить. В ответе train: {id, manual, state, schedule}',
      manual_mode: 'цель — локомотив или вагон: false — пустить поезд по расписанию, true — ручной режим (поезд останавливается)',
      launch: 'цель — ракетная шахта: true — кнопка запуска готовой ракеты (inspect → rocket.status: rocket_ready, иначе not_allowed). Груз заранее кладётся transfer put с inventory: "rocket" ' +
        '(вместимость — по весу; забрать обратно — transfer take с inventory: "rocket"). Стартовый набор платформы (space-platform-starter-pack) летит к платформе команды, ' +
        'ждущей такой набор на орбите этой планеты, а если такой нет — становится новой платформой: в ответе platform {name, created?}. Если платформа уже ждёт набор, игра запускает ракету сама, как только набор положен, — launch не нужен.Прочий груз летит, куда решит игра. ' +
        'В ответе launched, cargo, rocket (стадия)',
      platform_requests: 'цель — ракетная шахта: true | false — галочка «автоматические запросы для космических платформ»; пока она включена, руками груз в ракету не кладётся',
      control: 'настройки логики: объект полей управляющего поведения (circuit_enable_disable, circuit_condition, …)',
      wire: '{to: цель, type: red | green | copper, disconnect?} — провод между двумя объектами в досягаемости',
      copy_from: 'цель — скопировать настройки с другой постройки (как shift-клики)',
      request_items: 'заявка роботам на предметы для СТОЯЩЕЙ постройки (турель, печь, автомат — сносить не нужно): {предмет: количество} или список {item, count, inventory?, quality?}. ' +
        'Строительные роботы привезут предметы из сети, если постройка в зоне строительства робопорта (в ответе robots_in_range). inventory по умолчанию: патроны — ammo, модули — modules, ' +
        'топливо — fuel, иначе main; можно задать явно (fuel, input, modules, ammo, main, robots). Нет места в слотах — no_space. Новая заявка заменяет прежнюю; false — снять заявку. ' +
        'В ответе request_items {предмет: количество}; что ещё не привезли — inspect → requests. ' +
        'Досягаемость тела для заявки не нужна (как у игрока с карты): достаточно, чтобы постройка была видна вживую (радар, обзор бота или человека) — тогда в ответе remote: true; ' +
        'вне обзора — out_of_reach (подойди или approach: true). Если в том же элементе есть другие настройки, досягаемость нужна, как обычно',
      items: 'или список {target, …настройки}', approach: 'true — самому обходить цели вне досягаемости',
    },
    result: '{name, x, y, unit, direction, recipe?, …}',
    example: { target: { x: 4, y: 0 }, recipe: 'iron-gear-wheel' },
  },
  research: {
    kind: 'action', instant: true,
    summary: 'Очередь исследований команды: добавить в конец, убрать, задать порядок целиком. Посмотреть исследования — research_info.',
    params: { add: 'имя или список имён технологий', remove: 'имя или список', set: 'список — новая очередь целиком' },
    result: '{queue, current, skipped: [{name, reason}]}',
    example: { add: ['logistics-2', 'steel-axe'] },
  },

  // ── Планирование: призраки, пометки, чертежи (тело не занимают, досягаемость не нужна) ──
  ghost_place: {
    kind: 'action', instant: true,
    summary: 'Поставить призраки построек и плитки — план на карте, виден людям и ботам; предметы и досягаемость не нужны, область должна быть открыта на карте. ' +
      'Что ставить: список items с готовыми координатами, либо сохранённый чертёж blueprint, либо строка чертежа string (тогда x, y — клетка северо-западного угла, ' +
      'можно повернуть и отразить). Поверх совместимых построек (в ответе replace и replace_items) план ставит замену: тот же вид и направление, ' +
      'но другая модель (лента → быстрая лента) — пометка замены (marked_upgrade); иначе (подземный конвейер или разделитель поверх ленты, другое направление) — ' +
      'призрак, а старое помечается на снос (marked_deconstruct). И то и другое входит в план и строится build_ghosts быстрой заменой на месте. ' +
      'Исполняет план build_ghosts (и mine для прочего помеченного на снос).',
    params: {
      plan: 'имя плана — метка на поставленных призраках и пометках (по ней ghosts, build_ghosts, ghost_clear, mine)',
      items: 'список построек {name (или item), x, y, direction?, recipe?, underground?: input | output, …поля чертежа игры (control_behavior, items)}; ' +
        'манипулятору фильтры — filters: список имён предметов (или {index, name, quality?, comparator?}), filter_mode?: whitelist | blacklist; ' +
        'фильтр включается сам (выключить — use_filters: false). Настройки из списка применяются и к уже стоящей такой же постройке (already): ' +
        'так меняют фильтр издалека. В строке чертежа (string) поле игры называется use_filters — без него фильтры выключены; ' +
        'рельсы стоят на сетке 2×2 — центр прямого рельса в нечётных x и y, как у уже построенных. ' +
        'Поворот рельсов на 90° (стоимость — предметы rail):От последнего прямого рельса (x, y) direction north ' +
        'путь уходит на север и сворачивает на восток: curved-rail-a (x, y−3) northeast; curved-rail-b (x+2, y−8) northeast; curved-rail-b (x+6, y−12) west; ' +
        'curved-rail-a (x+11, y−14) west; дальше прямые straight-rail direction east от (x+14, y−14) с шагом 2 по x. Эта же дуга соединяет путь, идущий ' +
        'с востока на запад, с путём на юг. Остальные три дуги — поворот набора на 90° по часовой вокруг (x, y), сколько нужно раз: смещение (dx, dy) → (−dy, dx), ' +
        'direction — следующее через одно по кругу north, northeast, east, southeast, south, southwest, west, northwest (north → east, northeast → southeast, west → north). ' +
        'Диагональ (поворот на 45°): между двумя curved-rail-b вставь n диагональных straight-rail direction northeast в (x+5+2i, y−11−2i), i = 0…n−1, ' +
        'а всё, что после них, сдвинь на (+2n, −2n). Проще — rail_path: он сам считает части пути по шагам straight / left / right. ' +
        'Перед постановкой проверь blueprint_check, после постройки — inspect рельса (rail_ends: стыки) и trains',
      tiles: 'список плитки {name: stone-path | concrete | landfill | …, x, y}',
      blueprint: 'или имя сохранённого чертежа', string: 'или строка чертежа в формате игры',
      x: 'клетка северо-западного угла чертежа', y: '',
      rotation: '0 | 90 | 180 | 270 по часовой (для чертежа)', flip: '"h" — слева направо, "v" — сверху вниз (для чертежа)',
      mode: 'forced (по умолчанию: ставится всё, что можно; мешающие деревья и камни помечаются на снос), ' +
        'superforced (на снос помечается всё мешающее, включая постройки), normal (не ставится ничего, если мешает хоть что-то)',
    },
    result: '{plan, origin, size, total, placed, placed_tiles, already, already_planned, replace, blocked, blocked_items: [{name, x, y, by, nature?}], ' +
      'marked_deconstruct, marked_upgrade, cost, have, missing}',
    example: { plan: 'smelter-1', items: [{ name: 'stone-furnace', x: 10, y: 5 }, { name: 'inserter', x: 10.5, y: 6.5, direction: 'north' }] },
  },
  ghost_clear: {
    kind: 'action', instant: true,
    summary: 'Убрать призраки: своего плана целиком (вместе с его пометками сноса и замены), в области или по списку. Постройки не трогает. ' +
      'В области убираются только призраки своих планов; all: true — любые призраки команды.',
    params: { plan: 'имя плана', area: '{x1, y1, x2, y2}', ghosts: 'список целей {x, y}', all: 'true — и чужие призраки в области' },
    result: '{removed, unmarked, kept}', example: { plan: 'smelter-1' },
  },
  mark_deconstruct: {
    kind: 'action', instant: true,
    summary: 'Пометить на снос, как планировщиком разборки: постройки своей команды в области или по списку; деревья и камни — с nature: true или по names. ' +
      'Снимает помеченное mine с marked: true (или роботы). cancel: true — снять пометки.',
    params: {
      area: '{x1, y1, x2, y2}', targets: 'или список целей', names: 'только такие объекты: имена построек, "tree", "rock"',
      nature: 'true — вместе с деревьями и камнями', plan: 'имя плана для пометок', cancel: 'true — снять пометки',
    },
    result: '{marked | unmarked, already, by_name, plan}', example: { area: { x1: 0, y1: 0, x2: 12, y2: 8 }, names: ['transport-belt'], plan: 'move-1' },
  },
  mark_upgrade: {
    kind: 'action', instant: true,
    summary: 'Пометить на замену, как планировщиком улучшений: заменить постройки вида from на вид to в области (ленты, манипуляторы, печи). ' +
      'Исполняет build_ghosts по области: быстрая замена на месте, старая постройка возвращается в инвентарь, содержимое и настройки сохраняются.',
    params: { area: '{x1, y1, x2, y2}', targets: 'или список целей', from: 'имя постройки', to: 'на что заменить', plan: 'имя плана', cancel: 'true — снять пометки' },
    result: '{marked | unmarked, plan}', example: { area: { x1: 0, y1: 0, x2: 30, y2: 2 }, from: 'transport-belt', to: 'fast-transport-belt' },
  },
  ghosts: {
    kind: 'query',
    summary: 'Планы на карте. Без параметров — список планов (имя, автор, сколько осталось, границы). С plan и/или area — призраки и пометки: ' +
      'сколько каких, стоимость, что из этого есть в инвентаре и чего не хватает, сам список постранично.',
    params: { plan: 'имя плана', area: '{x1, y1, x2, y2}', limit: 'сколько элементов списка отдать (по умолчанию 200)', offset: 'с какого элемента' },
    result: '{plans: [{name, by, left, bounds}]} или {total, ghosts, tiles, deconstruct, upgrade, bounds, cost, have, missing, items: [{kind: ghost | tile | deconstruct | upgrade, name, x, y, unit, plan, direction?, to? (на что заменить), ' +
      'replaces? (призрак встанет быстрой заменой вместо этой постройки, помеченной на снос)}], more?}',
    example: { plan: 'smelter-1' },
  },
  blueprint_save: {
    kind: 'control', write: true,
    summary: 'Собрать чертёж из списка построек и сохранить под именем. Координаты — любые согласованные между собой: чертёж приводится к виду ' +
      '«северо-западный угол в (0, 0)». Среди ботов свои чертежи видит только их бот; team: true — общий для команды. ' +
      'Люди видят все сохранённые чертежи (свои каждого бота и общие) в игре: кнопка «Боты» → «Чертежи ботов», оттуда чертёж или ' +
      'книгу раздела берут в руку; список следует за сохранением и blueprint_delete. Строку передавать вручную не нужно.',
    params: { name: 'имя чертежа', entities: 'список {name (или item), x, y, direction?, recipe?, …}', tiles: 'список плитки {name, x, y}', team: 'true — общий' },
    result: '{name, owner, w, h, entities, tiles, cost, origin}', example: { name: 'furnace-pair', entities: [{ name: 'stone-furnace', x: 1, y: 1 }, { name: 'stone-furnace', x: 3, y: 1 }] },
  },
  blueprint_capture: {
    kind: 'control', write: true,
    summary: 'Снять существующие постройки области в чертёж вместе с настройками (рецепты, фильтры, провода). origin в ответе — где на карте был ' +
      'северо-западный угол: перенос блока — это capture, mark_deconstruct той же области и ghost_place чертежа в новом месте.',
    params: { name: 'имя чертежа', area: '{x1, y1, x2, y2}', tiles: 'true — вместе с плиткой', team: 'true — общий' },
    result: '{name, owner, w, h, entities, tiles, cost, origin: {x, y}}', example: { name: 'block-a', area: { x1: 0, y1: 0, x2: 12, y2: 8 } },
  },
  blueprint_import: {
    kind: 'control', write: true,
    summary: 'Сохранить чертёж из строки формата игры (такой, какую копируют люди). Книга чертежей сохраняется как набор «имя/метка».',
    params: { name: 'имя', string: 'строка чертежа или книги', team: 'true — общий' },
    result: '{saved: [{name, w, h, entities, cost}]}', example: { name: 'from-human', string: '0eNq…' },
  },
  blueprint_export: {
    kind: 'query',
    summary: 'Строка чертежа в формате игры — её можно отдать человеку или другому боту. С names — несколько чертежей одной книгой.',
    params: { name: 'имя чертежа', names: 'или список имён — книга', book: 'название книги' },
    result: '{string, w, h}', example: { name: 'furnace-pair' },
  },
  blueprint_list: { kind: 'query', summary: 'Свои и общие чертежи: размер, число построек, стоимость.', params: {}, result: '{blueprints: [{name, owner: me | team, by, w, h, entities, tiles, cost}]}', example: {} },
  blueprint_get: {
    kind: 'query',
    summary: 'Содержимое чертежа списком (с учётом поворота и отражения): чтобы посмотреть, изменить своим кодом и сохранить заново.',
    params: { name: 'имя', rotation: '0 | 90 | 180 | 270', flip: '"h" | "v"' },
    result: '{w, h, cost, items: [{name, x, y, direction?, recipe?, …}], tile_items: [{name, x, y}]}', example: { name: 'furnace-pair', rotation: 90 },
  },
  blueprint_delete: { kind: 'control', write: true, summary: 'Удалить свой чертёж (общий — только автор). Постройки и призраки на карте не трогает.', params: { name: 'имя' }, result: '{deleted}', example: { name: 'furnace-pair' } },
  blueprint_check: {
    kind: 'query',
    summary: 'Проверка без постановки: что из чертежа или списка встанет в этом месте, что упирается во что, сколько стоит, чего не хватает в инвентаре. Параметры — как у ghost_place.',
    params: { items: 'список построек', tiles: 'список плитки', blueprint: 'или имя чертежа', string: 'или строка', x: 'клетка северо-западного угла', y: '', rotation: '', flip: '' },
    result: '{origin, size, total, will_place, already, already_planned, replace, blocked, blocked_items, replace_items, cost, have, missing, charted}',
    example: { blueprint: 'furnace-pair', x: 20, y: -4, rotation: 90 },
  },
  rail_path: {
    kind: 'query',
    summary: 'Рельсовый планировщик: координаты частей пути (прямые, кривые, диагонали) по твоим шагам — готовый список items для ghost_place. ' +
      'Ничего не ставит, местность не смотрит и маршрут не выбирает: считает только геометрию, как планировщик рельсов игры. ' +
      'from — рельс, от которого продолжаешь (построенный или задуманный: name, x, y, direction как в inspect), heading — в какую сторону от него идти ' +
      '(один из двух концов рельса; у прямого north–south это north или south). Шаги: straight — часть прямо, left / right — часть с поворотом на 22,5° ' +
      'против / по часовой стрелке. Поворот на 90° — четыре одинаковых шага подряд (конец пути уходит на 13 клеток вперёд и 13 вбок); ' +
      "на 45° — два, дальше straight идёт по диагонали; ['left', 'right'] — сдвиг пути вбок на 2 клетки с прежним направлением. " +
      'Прямой шаг по горизонтали и вертикали — 2 клетки, по диагонали — 2 по x и 2 по y. ' +
      'end — конец получившегося пути: точка стыка и направление движения в ней; следующий запрос продолжай от последней части items с heading = end.direction. ' +
      'Чтобы прийти в уже стоящий рельс, передай его в to: joins — состыкуется ли путь, to_ends — какие end для этого годятся ' +
      '(подбери шаги так, чтобы end совпал с одним из них). Сам from в items не входит.',
    params: {
      from: '{name?: straight-rail | curved-rail-a | curved-rail-b | half-diagonal-rail (по умолчанию straight-rail), x, y, direction}',
      heading: 'north | northnortheast | northeast | … — направление движения с конца рельса from; при ошибке в data.headings — допустимые',
      moves: "список шагов 'straight' | 'left' | 'right', с повтором: 'straight*10' (до 600 частей за запрос)",
      to: 'необязательно: рельс {name?, x, y, direction}, в который путь должен прийти',
    },
    result: '{items: [{name, x, y, direction}], count, end: {x, y, direction}, joins?, to_ends?: [{x, y, direction}]}',
    example: { from: { x: -125, y: 151, direction: 'north' }, heading: 'north', moves: ['straight*3', 'right*4', 'straight*5'] },
  },

  // ── Наблюдение: то, что игрок видит на экране, на карте и в окнах игры ──
  inspect: {
    kind: 'query',
    summary: 'Окно объекта: рецепт, состояние, содержимое по слотам, топливо, направление, жидкости, провода. Одна цель или список targets (до 200). ' +
      'Объекта нет — обычный ответ {found: false}. Вне обзора — только вид и место по памяти карты (memory: true). ' +
      'fluids — ёмкости жидкости по порядку окна: [{name, amount, capacity, temperature, segment?}]; пустая ёмкость видна, только если жидкость задана рецептом ' +
      'или фильтром (amount: 0); у труб segment {name, amount, capacity} — вся связанная труба целиком. ' +
      'У ракетной шахты rocket: {status (building_rocket … rocket_ready … rocket_flying), parts, parts_required, platform_requests, cargo_weight, cargo_max_weight}; груз — inventory.rocket. ' +
      'У рельса rail_ends — оба конца: [{x, y, heading, open, connected: [{name, x, y, direction, turn: left | straight | right}]}]; ' +
      'open: true — к концу ничего не пристыковано (разрыв или тупик). Призраки рельсов стыков не показывают — проверяй после постройки.',
    params: { target: '{x, y, name?}', targets: 'или список целей' },
    result: '{found, name, type, unit, x, y, direction, health, status, recipe, inventory: {fuel, input, output, modules, main, ammo, robots}, slots, free_slots, robot_slots, free_robot_slots (робопорт: slots — ремкомплекты, robot_slots — роботы), requests: {предмет: количество} — заявка роботам, ещё не привезённая (configure request_items), fluids, lanes, wires, distance, in_reach, …} или {objects: [...]}',
    example: { target: { x: 10, y: 5 } },
  },
  area: {
    kind: 'query',
    summary: 'Карта прямоугольника символами: клетка — символ, расшифровка в legend. По запросу — список объектов. До 4096 клеток за вызов (например 64×64); большее запрашивай частями.',
    params: {
      area: '{x1, y1, x2, y2}', radius: 'или квадрат вокруг x, y (без них — вокруг персонажа)', x: '', y: '',
      objects: 'true — приложить список объектов (name, x, y, unit, direction)', details: 'true — объекты с полным описанием, как inspect',
      nature: 'true — включить в список деревья и камни', limit: 'сколько объектов отдать (по умолчанию 300)', offset: 'с какого',
    },
    result: "{x1, y1, x2, y2, width, height, rows: [строка на ряд клеток], legend: {символ: имя}, resources: {имя: {tiles, amount}}, fog_rows? ('v' видно, 'm' по памяти карты, '?' не открыто), objects?, more?}",
    example: { radius: 12, objects: true },
  },
  find: {
    kind: 'query',
    summary: 'Поиск на карте по имени или типу в радиусе (до 300) вокруг точки или персонажа: ближайшие объекты и сводка по именам. Скрытое туманом не находится: ' +
      'пустой ответ значит «никого нет» только там, где есть обзор. view — насколько радиус покрыт обзором: visible_percent — доля чанков, видимых вживую ' +
      '(враги, персонажи и предметы на земле находятся только в них), charted_percent — открытых на карте (постройки и ресурсы по памяти карты), ' +
      'nearest_hidden — ближайший к центру чанк без обзора (его центр, distance — от центра поиска до его края; state: charted — на карте, но не виден, unknown — не открыт): ' +
      'ближе этого расстояния видно всё.',
    params: { name: 'имя объекта (iron-ore, stone-furnace, …)', names: 'или список имён', type: 'или тип (tree, resource, furnace, …)', ghost: 'true — искать призраки с таким именем',
      x: '', y: '', radius: 'по умолчанию 60', limit: 'по умолчанию 30' },
    result: '{total, by_name: {имя: {count, nearest, x, y, amount?}}, objects: [{name, type, x, y, unit, distance, amount?, memory?}], more?, ' +
      'view: {visible_percent, charted_percent, nearest_hidden?: {x, y, distance, state}}}',
    example: { name: 'iron-ore', radius: 150 },
  },
  production: {
    kind: 'query',
    summary: 'Окно производства: сколько каждого предмета и жидкости произведено и потреблено в минуту за интервал, и всего.',
    params: { window: '5s | 1m | 10m (по умолчанию) | 1h | 10h | 50h', items: 'список имён — только они', limit: 'по умолчанию 40' },
    result: '{window, items: [{name, produced_per_min, consumed_per_min, produced_total, consumed_total}], fluids: [...]}',
    example: { window: '10m', items: ['iron-plate', 'copper-plate'] },
  },
  power: {
    kind: 'query',
    summary: 'Окно электросети столба (по умолчанию ближайшего в 80 клетках): выработка и потребление по видам машин, установленная мощность, аккумуляторы, машины без питания. ' +
      'capacity_kw и generators — максимум генераторов этой сети, стоящих в radius от столба (электростанция дальше — увеличь radius или укажи столб у неё): ' +
      'паровые двигатели и турбины — по паспорту (при полном снабжении паром), солнечные панели — дневной максимум. Запас сети — capacity_kw минус consumption_kw. ' +
      'Столба в 80 клетках нет — ответ с network: null, нулями и note.',
    params: { target: 'столб: {x, y}', radius: 'в каком радиусе от столба искать генераторы, аккумуляторы и машины без питания (по умолчанию 48, до 150)' },
    result: '{pole, network, production_kw, production: [{name, kw}], consumption_kw, consumption, capacity_kw, generators: [{name, count, max_kw}], ' +
      'accumulators: {charge — доля, charge_mj, capacity_mj}, machines: {ok, low_power, no_power}, satisfied, problems: [{name, x, y, status}]}',
    example: {},
  },
  alerts: {
    kind: 'query',
    summary: 'Что на базе встало: машины с проблемным состоянием в радиусе (нет топлива, нет энергии, нет патронов, кончился ресурс), и тревоги игрока, если в команде есть люди. ' +
      'all: true — вместе с «мягкими» состояниями (нет сырья, выход забит, нет рецепта).',
    params: { x: '', y: '', radius: 'по умолчанию 150', all: 'true — и мягкие состояния', limit: 'по умолчанию 100' },
    result: '{by_status: {состояние: количество}, problems: [{status, name, x, y, unit}], player_alerts: [{alert, name, x, y}]}',
    example: { radius: 200 },
  },
  pollution: {
    kind: 'query',
    summary: 'Слой загрязнения на карте: значения по чанкам вокруг точки или персонажа.',
    params: { x: '', y: '', radius: 'по умолчанию 160' },
    result: '{here, max, max_at, total, chunk_x1, chunk_y1, rows: [[…]]} — rows[j][i] — чанк (chunk_x1 + i, chunk_y1 + j), -1 — не открыт',
    example: {},
  },
  enemies: {
    kind: 'query',
    summary: 'Слой врагов на карте: гнёзда и черви на открытой карте, отряды — только в видимой зоне; эволюция и из чего она сложилась ' +
      '(как в команде /evolution): evolution_by — доли в процентах от времени, загрязнения и уничтоженных гнёзд. Растёт ли kills после зачистки гнёзд, видно по сравнению до и после. ' +
      'view — насколько радиус покрыт обзором (как в find): при visible_percent < 100 units_total: 0 не значит, что врагов нет, — отряды дальше view.nearest_hidden.distance могут быть не видны.',
    params: { x: '', y: '', radius: 'по умолчанию 150 (до 500)' },
    result: '{evolution (0…1), evolution_percent, evolution_by: {time, pollution, kills}, nests: [{name, x, y, distance, memory?}], worms, units: {имя: количество}, units_total, nearest_unit, ' +
      'view: {visible_percent, charted_percent, nearest_hidden?: {x, y, distance, state}}}',
    example: { radius: 300 },
  },
  logistics: {
    kind: 'query',
    summary: 'Окно логистической сети в точке или у персонажа: роботы, запасы, число запросчиков и поставщиков.',
    params: { x: '', y: '' },
    result: '{in_network, roboports, logistic_robots: {total, available}, construction_robots, items: {предмет: количество}, requesters, providers, storages} или {in_network: false, networks}',
    example: {},
  },
  logistic_requests: {
    kind: 'control', write: true,
    summary: 'Личные логистические запросы персонажа (вкладка логистики в окне персонажа): роботы сети, в зоне которой стоит персонаж, довозят предметы до min, ' +
      'а лишнее сверх max уносят из мусорных слотов. Без параметров — только показать текущие. Доступно после исследования logistic-robotics (иначе available: false, а изменение — not_allowed).',
    params: {
      set: 'список {item, min, max?, quality?}: поставить или изменить запрос предмета (max не задан — без верхнего предела; min: 0 и max — только выбрасывать лишнее)',
      clear: 'true — снять все запросы; или список предметов, чьи запросы снять',
      enabled: 'true | false — галочка «личная логистика и автомусор» (запросы остаются, но не исполняются)',
    },
    result: '{available, enabled, in_network — стоит ли персонаж в зоне логистической сети, requests: [{item, quality?, min, max?, have — сколько сейчас в инвентаре}], trash_slots, trash: {предмет: количество}}',
    example: { set: [{ item: 'iron-plate', min: 100, max: 200 }] },
  },
  trains: { kind: 'query', summary: 'Обзор поездов и станций команды.', params: {}, result: '{trains: [{id, state, manual, speed, x, y, at_station, going_to, schedule, schedule_current, stops: [{station, wait: [{type, ticks?, …}]}], cargo}] (расписание задаётся через configure: schedule, manual_mode), stations: [{station, x, y, trains_count, trains_limit}]}', example: {} },
  recipes: {
    kind: 'query',
    summary: 'Справочник рецептов: по имени рецепта или предмета, который он даёт (name), либо все рецепты с ингредиентом (uses).',
    params: { name: 'рецепт или предмет', uses: 'или предмет-ингредиент' },
    result: '{recipes: [{recipe, ingredients, products, seconds, unlocked, by_hand, categories, unlocked_by?}]}',
    example: { name: 'electronic-circuit' },
  },
  prototypes: {
    kind: 'query',
    summary: 'Справочник: предмет, постройка, жидкость или плитка по внутреннему имени — размер, рамка столкновений, скорости, энергия, слоты.',
    params: { name: 'внутреннее имя' },
    result: '{item: {stack_size, places, fuel_mj}, entity: {type, width, height, collision_box, crafting_speed, energy_usage_kw, …}}',
    example: { name: 'assembling-machine-2' },
  },
  research_info: {
    kind: 'query',
    summary: 'Окно исследований: текущее (с прогрессом), очередь, доступные сейчас технологии со стоимостью; с name — одна технология и что она открывает. ' +
      'Менять очередь — действие research. Технология с trigger открывается не наукой, а действием, и в очередь не ставится: ' +
      'craft-item — скрафтить count предметов item (руками через craft или в машинах), build-entity — поставить постройку entity, ' +
      'mine-entity — добыть одно из entities, craft-fluid — получить жидкость в машинах. Ручной крафт и добыча ботов (craft, mine) ' +
      'засчитываются, как у игрока: только когда предпосылки технологии уже исследованы (missing_prerequisites пуст) — сделанное раньше не в счёт, повтори.',
    params: { name: 'имя технологии', limit: 'сколько доступных показать (по умолчанию 30)',
      researched: 'true — добавить список изученного: researched [{name, level, infinite?}] (у бесконечной технологии level — сколько уровней уже пройдено)' },
    result: '{current: {name, progress, units, ingredients}, queue: [...], available: [{name, units, seconds_per_unit, ingredients, ' +
      'trigger?: {type, item?, count?, entity?, entities?, fluid?, amount?, quality?}}], researched?: [{name, level, infinite?}], researched_total?, technology?}',
    example: {},
  },
  chat: {
    kind: 'query',
    summary: 'Игровой чат: последние сообщения людей и ботов. Новые сообщения приходят и событием chat.',
    params: { since: 'номер последнего виденного сообщения', limit: 'по умолчанию 50' },
    result: '{messages: [{seq, from, text, bot?, tick}], seq}', example: {},
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
  logout: {
    kind: 'control', write: true,
    summary: 'Выйти из игры: персонаж исчезает из мира со всем, что на нём, — как у человека, который отключился. Пока его нет, его нельзя убить или обобрать, ' +
      'и он ничего не делает: очередь действий отменяется, ручной крафт замирает и продолжится после возвращения. Вызывай, когда заканчиваешь работу надолго. ' +
      'После выхода все операции с персонажем отвечают кодом offline, пока не вызван login; ping, help, events, feedback работают.',
    params: {},
    result: '{offline: true, position, surface, cancelled — сколько действий отменено, crafting_paused — сколько рецептов осталось в очереди крафта}',
    example: {},
  },
  login: {
    kind: 'control', write: true,
    summary: 'Вернуться в игру после logout: персонаж появляется там же, где вышел (если место заняли — рядом), с тем же инвентарём, здоровьем и очередью крафта.',
    params: {},
    result: '{offline: false, position, surface, moved — true, если встал не на прежнее место, crafting}',
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
    result: '{name, position, health, inventory: {предмет: количество}, free_slots, guns, ammo, armor, weapons: [{slot, gun?, ammo?, count?}] — слоты оружия и патронов по номерам (менять — equip / unequip), shooting: {mode, seconds_left, killed, target?, at?} — если зажат огонь (shoot), throwing: {item, thrown, count, next_in_ticks, target?, at?} — если идёт серия бросков (throw),crafting, queue, reach: {build, interact, resource}, tick, paused, deaths}. ' +
      'Между гибелью и возрождением персонажа нет, ответ другой: {name, dead: true, respawn_in — секунд игры до возрождения, respawn_tick, died_position — где труп, respawn_position, deaths, tick, paused}',
    example: {},
  },
  agents: {
    kind: 'query', agent: false,
    summary: 'Все боты: имя, жив ли, позиция, здоровье, текущее действие, длина очереди.',
    params: {},
    result: '{agents: [{name, alive, position, health, action, queue, dead? — погиб и ждёт возрождения, respawn_in? — через сколько секунд}]}',
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
    params: {}, result: '{mod, version, build, api, tick, paused, hold — игра остановлена людьми, действия не принимаются, ops, actions}', example: {},
  },
  busy: {
    kind: 'query', agent: false,
    summary: 'Сколько ботов заняты (непустая очередь действий или ручного крафта) и стоит ли игра на паузе.',
    params: {}, result: '{busy, paused}', example: {},
  },

  feedback: {
    kind: 'control', agent: false,
    summary: 'Заявка разработчикам: ошибка интерфейса или то, чего в нём не хватает (не для игровых вопросов). Заявки разбирает обработчик; ' +
      'о решении придёт сообщение в игровой чат от «разработчики». Правки мода и сервера выходят пакетами — обновлением игры, не чаще раза в 30 минут, ' +
      'поэтому выполненная заявка может начать действовать не сразу (см. feedback_status).',
    params: { text: 'что делал (операция и параметры), что получил, чего ожидал' }, result: '{accepted: номер заявки}',
    example: { text: 'transfer take из лаборатории не забирает колбы: target {x: 10, y: 5}, ответ no_item, в inspect колбы есть' },
  },
  feedback_status: {
    kind: 'query', agent: false,
    summary: 'Что стало с заявками: свои (или все — all: true) со статусом и ответом. Статусы: new — в очереди, done — выполнена ' +
      '(released: false — выйдет со следующим обновлением), rejected — отклонена, discussion — ждёт решения людей.',
    params: { all: 'true — заявки всех ботов', limit: 'сколько последних показать (по умолчанию 15)' },
    result: '{feedback: [{id, from, at, text, status, answer, released}], waiting — сколько заявок в очереди}', example: {},
  },

  // ── Администратору ──
  show: {
    kind: 'control', admin: true,
    summary: 'Открыть человеку в игре список ботов, окно-камеру или слежение за ботом (то же, что его кнопки в интерфейсе).',
    params: { player: 'имя игрока', what: 'list | camera | follow | overlay', agent: 'имя бота — для camera и follow' },
    result: '{shown}', example: { player: 'darkkeks', what: 'camera', agent: 'darkkeks-бот' },
  },
  legacy_report: { kind: 'control', admin: true, summary: 'Что перенесено со старой системы при первом запуске мода на карте.', params: {}, result: '{plans, ghosts, done, marks, blueprints}', example: {} },
  metrics: { kind: 'control', admin: true, summary: 'Счётчики вызовов и времени ответа по операциям.', params: {}, result: '{ops, errors, journal}', example: {} },
  pause_if_idle: {
    kind: 'control', admin: true,
    summary: 'Правило паузы одним шагом: пауза, если в игре нет людей и ни один подключённый бот ничего не делает; иначе игра идёт.',
    params: { ignore: 'имена игроков, которых не считать людьми (клиент-камера)', now: 'настоящее время, секунды (по нему считается, подключён ли бот)', keep: 'true — паузу не ставить', bots_off: 'true — режим ожидания: боты игру не держат' },
    result: '{paused, changed, humans, busy, silent}', example: { ignore: ['camera'], now: 1794839000 },
  },
  announce: {
    kind: 'control', admin: true,
    summary: 'Объявление в игровой чат не от бота (ответы разработчиков, сообщения об обновлениях); ботам приходит событием chat.',
    params: { text: 'текст', from: 'подпись, по умолчанию «разработчики»' },
    result: '{sent}', example: { text: 'Сервер перезапустится через минуту.' },
  },
};

export const EVENT_TYPES = {
  action_done: 'своё действие завершено: {action_id, action, ok, result | error, ticks}',
  queue_empty: 'своя очередь действий опустела',
  craft_done: 'очередь ручного крафта опустела',
  agent_damaged: 'свой персонаж получил урон: {health, damage, by, position}; не чаще раза в 5 секунд',
  agent_died: 'свой персонаж погиб: {position — место трупа, by, respawn_in — через сколько секунд игры возродится (10, как у игрока в сетевой игре), respawn_tick, respawn_position — точка возрождения, ' +
    'lost: {предмет: количество} — что осталось в трупе}. Возрождение само, по времени; ускорить или отложить его нельзя. До него персонажа нет: status отвечает {dead: true, respawn_in}, ' +
    'действия и запросы о мире — ошибкой dead (в data — respawn_in), работают status, queue, chat, events, help. Жди событие agent_respawned (events с wait_s). ' +
    'Новый персонаж — у точки возрождения, с пустым инвентарём; если там враги, он может погибнуть снова — сразу после agent_respawned смотри enemies / enemies_near и уходи. Труп лежит, пока из него не заберут всё (сам не исчезает, старый с новым не сливается, враги его не трогают): inspect с target {x, y, name: "character-corpse"} → ' +
    '{items, bot — чей, died_tick}; забрать — transfer take с той же целью',
  agent_respawned: 'свой персонаж возродился после гибели: {position — где появился, died_position — где труп, dead_ticks — сколько тиков его не было}',
  corpse_gone: 'труп своего персонажа исчез: {position, reason: emptied — из него забрали всё | mined — снят человеком | expired, by? — бот, последним бравший из трупа, или человек, снявший его, ' +
    'died_tick, items_left? — что пропало вместе с трупом}. Если вещи забрал человек через окно трупа, by нет',
  entity_damaged: 'постройка команды повреждена: {name, unit, position, health, max_health, by}; по одному объекту не чаще раза в 5 секунд',
  entity_died: 'постройка команды разрушена: {name, unit, position, by, by_force}',
  research_finished: 'исследование завершено: {name, level}',
  chat: 'сообщение в игровом чате: {from, text, bot? — от бота}',
  player_joined: 'человек зашёл в игру: {name}',
  player_left: 'человек вышел: {name}',
  agent_created: 'появился новый бот: {name}',
  agent_logout: 'бот вышел из игры (logout): {name}',
  agent_login: 'бот вернулся в игру (login): {name}',
  entities_built: 'кто-то другой (человек, бот, роботы) построил: {by, count, names: {имя: количество}, area}; сводка раз в секунду',
  entities_removed: 'кто-то другой снял постройки: {by, count, names, area}',
  enemies_near: 'враги в 32 клетках от твоего персонажа: {count, prev_count?, nearest: {name, x, y, distance}}; проверка дважды в секунду. Событие приходит, когда враги появились ' +
    '(после того как их не было; не чаще раза в 2 секунды), когда их стало заметно больше, чем в прошлом событии (в полтора раза и хотя бы на 2 — подошла новая группа; ' +
    'prev_count — сколько было; не чаще раза в секунду) и раз в 10 секунд, пока они рядом',
  agent_health: 'здоровье твоего персонажа упало через порог 75, 50 или 25 %: {health, max_health, threshold, by, position}; приходит сразу, без ограничения частоты ' +
    '(одно попадание через несколько порогов — одно событие с нижним)',
  shooting_done: 'огонь (shoot) прекращён: {reason: duration | no_ammo | target_dead | stopped | replaced | died | logout, action_id, mode, killed, kills: {имя врага: число}, seconds, ammo_left, health, position}',
  throw_done: 'серия бросков (throw) закончена не в ответе на команду: {reason: done | no_item | target_dead | out_of_range | no_cliff | full_health | stopped | replaced | died | logout, action_id, item, thrown, count, left, health, position}',
  attack_group:'отряд врагов собрался в атаку: {size, position}',
  enemy_base_built: 'враги построили новую базу на открытой карте: {name, position}',
  turret_no_ammo: 'турель без патронов: {name, unit, position}; по одной турели не чаще раза в минуту',
  alert: 'у машин кончилось топливо или пропала энергия: {status: no_fuel | no_power, count, examples: [{name, unit, x, y}]}',
  inventory_full: 'добыча остановлена: инвентарь персонажа полон',
  research_queue: 'бот изменил очередь исследований: {by, queue}',
};

export const ERROR_CODES = {
  bad_request: 'неверные аргументы (HTTP 400)',
  unauthorized: 'нет или неверный токен (HTTP 401)',
  forbidden: 'операция не для этого токена (HTTP 403)',
  unknown_op: 'нет такой операции (HTTP 404)',
  game_unavailable: 'сервер игры недоступен (HTTP 503)',
  offline: 'персонаж вне игры после logout; вернуться — login',
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
  dead: 'персонаж погиб во время действия либо ещё не возродился после гибели (data: {respawn_in — секунд до возрождения, respawn_tick, position — где труп}); жди событие agent_respawned',
  paused: 'игра остановлена людьми (режим ожидания): действия не принимаются, чтение работает; ping показывает hold: true, пока режим не снят',
  cancelled: 'действие отменено (ботом, остановкой очереди или сторожем cancel_if_silent_s)',
  timeout: 'условие ожидания не выполнилось за отведённое время',
  not_allowed: 'игра этого не разрешает (рецепт не исследован, чужая команда и т. п.)',
  internal: 'внутренняя ошибка — сообщи разработчику',
};

export function helpDocument(info, publicUrl) {
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
        'по умолчанию 30, не больше 110; через внешний адрес — не больше 50). С wait: false или по истечении срока ответ — {ok: true, running: true, action_id}; действие продолжает исполняться, ' +
        'итог — событием action_done или вызовом wait_action. Обрыв соединения действие не отменяет.',
      instant: 'Мгновенные действия (instant) исполняются в том же тике, если очередь пуста; иначе встают в очередь по порядку. ' +
        'Несколько действий подряд — одним запросом act. Действия, которые не занимают тело, — say, craft, cancel_craft, research, shoot, stop_shooting, throw, stop_throwing и всё планирование ' +
        '(ghost_place, ghost_clear, mark_deconstruct, mark_upgrade) — отдельным запросом исполняются сразу, даже когда персонаж идёт или строит; ' +
        'внутри act вместе с действиями тела они идут по порядку списка (например walk_to, затем say).',
      idempotency: 'К пишущему запросу можно приложить свой "id" (строка). Повтор с тем же id вернёт сохранённый ответ и ничего не выполнит второй раз ' +
        '(для повтора после потерянного ответа). Запросы с разными id или без id исполняются каждый.',
      targets: 'Объект мира (цель) задаётся координатами: {x, y} — объект в этой точке (любая точка внутри постройки), {x, y, name} — именно такой объект ' +
        '(например руда под буром). Номер unit из ответов можно приложить для сверки: {x, y, unit} найдёт объект, только если это он же. ' +
        'Человек — {player: "имя"}, другой бот — {agent: "имя"} (например отдать предметы: transfer с target {player: …}).',
      coordinates: 'x растёт на восток, y — на юг. Клетка (tile) с углом (10, 5) имеет центр (10.5, 5.5). 60 тиков — секунда игры.',
      events: 'О происходящем узнавай из events (долгий опрос из параллельного скрипта), а не опросом мира.',
      restarts: 'Перезапуск сервера игры (обновление) для тебя прозрачен: очередь действий продолжается с того же места, запрос во время перезапуска ' +
        'не отклоняется, а ждёт и исполняется (ответ просто придёт позже). Перезапуск самого сервера ботов рвёт соединение на секунду: ' +
        'вызывай curl с --retry 5 --retry-connrefused, а к пишущим запросам прикладывай id — повтор не исполнит действие дважды.',
      pause: 'Игра идёт, пока в ней есть люди или хотя бы один подключённый бот что-то делает (непустая очередь действий или ручного крафта); ' +
        'иначе стоит на паузе. Поставленное действие само снимает паузу, чтение — нет: чтобы дождаться чего-то в мире (плавки, крафта в сборщиках), ' +
        'ставь wait. Бот, от которого 5 минут нет ни одного запроса, считается отключённым и игру не держит; его очередь продолжится, когда он вернётся.',
      hold: 'Люди могут остановить игру для всех ботов (режим ожидания): действия отклоняются с кодом paused, чтение работает, ping отвечает hold: true. ' +
        'Не повторяй действие в цикле — проверяй ping не чаще раза в минуту.',
    },
    connect: {
      url: publicUrl || undefined,
      token: 'Токен выдаёт администратор сервера (darkkeks): один токен — один персонаж. Персонаж появляется в игре при первом обращении ' +
        'и остаётся в мире, когда бот отключён. Токен — секрет владельца бота: в чат, заявки и журналы его не пиши.',
      start: 'ping — связь и состояние игры; status — где персонаж и что с ним; look и inspect — что вокруг; дальше действия. ' +
        'События (чат, урон, завершение действий) — долгим опросом events; с первого вызова бери since из ответа.',
      limits: 'Через внешний адрес один запрос ждёт не дольше 50 секунд: долгие действия возвращают running: true, итог — событием action_done или wait_action. ' +
        'Запросы одного персонажа исполняются по очереди. Тело запроса — до 4 МБ.',
      leaving: 'Заканчиваешь работу надолго — вызови logout: персонаж исчезнет из мира и будет в безопасности, пока тебя нет; вернуться — login. ' +
        'Без logout персонаж остаётся стоять в мире, и его могут убить.',
      feedback: 'Чего не хватает или что работает не так — операция feedback; ответ разработчиков придёт в feedback_status и в чат.',
    },
    operations: ops,
    event_types: EVENT_TYPES,
    error_codes: ERROR_CODES,
    mod: info ? { version: info.version, tick: info.tick } : undefined,
  };
}
