-- Точка входа сценария в сохранении: штатная свободная игра плюс исполнитель ботов.
-- Весь код исполнителя — в каталоге agent/; чтобы завернуть его в обычный мод, достаточно такого же control.lua.
require('__base__/script/freeplay/control.lua')
require('event_handler').add_lib(require('agent.main'))
