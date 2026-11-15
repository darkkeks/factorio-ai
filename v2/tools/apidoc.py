#!/usr/bin/env python3
"""Справка по API игры из runtime-api.json: apidoc.py LuaEntity.walking_state | LuaSurface.request_path | events on_script_path | concept PathfinderWaypoint | grep <слово>"""
import json, sys, os, re
d = json.load(open(os.path.expanduser('~/factorio-camera/factorio/doc-html/runtime-api.json')))
def short(x, n=100000): return json.dumps(x, ensure_ascii=False)[:n]
def typ(t):
    if isinstance(t, str): return t
    c = t.get('complex_type')
    if c == 'array': return f"array[{typ(t['value'])}]"
    if c == 'dictionary': return f"dict[{typ(t['key'])}→{typ(t['value'])}]"
    if c == 'union': return ' | '.join(typ(o) for o in t['options'])
    if c == 'literal': return repr(t['value'])
    if c == 'type': return typ(t['value'])
    if c in ('table', 'tuple'): return '{' + ', '.join(f"{p['name']}{'?' if p.get('optional') else ''}: {typ(p['type'])}" for p in t.get('parameters', [])) + '}'
    if c == 'LuaStruct': return 'struct{' + ', '.join(a['name'] for a in t.get('attributes', [])) + '}'
    if c == 'function': return 'function'
    return short(t, 200)
def show_method(m):
    ps = ', '.join(f"{p['name']}{'?' if p.get('optional') else ''}: {typ(p['type'])}" for p in m.get('parameters', []))
    print(f"  {m['name']}({ps}) -> {', '.join(typ(r['type']) + ('?' if r.get('optional') else '') for r in m.get('return_values', []))}")
    print('    ' + m.get('description', '').replace('\n', '\n    ')[:1500])
    for p in m.get('parameters', []):
        if p.get('description'): print(f"    - {p['name']}: {p['description'][:300]}")
    for g in m.get('variant_parameter_groups', []) or []:
        print(f"    [{g['name']}] " + ', '.join(f"{p['name']}: {typ(p['type'])}" for p in g['parameters']))
    if m.get('raises'): print('    raises: ' + ', '.join(r['name'] for r in m['raises']))
a = sys.argv[1:]
if a[0] == 'grep':
    pat = re.compile(a[1], re.I)
    for c in d['classes']:
        for m in c.get('methods', []) + c.get('attributes', []):
            if pat.search(m['name']): print(f"{c['name']}.{m['name']}")
    for e in d['events']:
        if pat.search(e['name']): print('event', e['name'])
    for c in d['concepts']:
        if pat.search(c['name']): print('concept', c['name'])
elif a[0] == 'events':
    for e in d['events']:
        if re.search(a[1], e['name']):
            print(e['name'], '-', e['description'][:600])
            for p in e['data']: print(f"   {p['name']}{'?' if p.get('optional') else ''}: {typ(p['type'])} — {p.get('description','')[:200]}")
elif a[0] == 'concept':
    for c in d['concepts']:
        if c['name'] == a[1]:
            print(c['name'], '-', c['description'][:1500]); print('  ', typ(c['type'])[:3000])
            t = c['type']
            if isinstance(t, dict):
                for p in t.get('parameters', []): print(f"   {p['name']}{'?' if p.get('optional') else ''}: {typ(p['type'])} — {p.get('description','')[:300]}")
elif a[0] == 'define':
    def walk(ds, pre):
        for x in ds:
            n = pre + x['name']
            if n == a[1]:
                print(n, [v['name'] for v in x.get('values', [])], [s['name'] for s in x.get('subkeys', [])])
            walk(x.get('subkeys', []), n + '.')
    walk(d['defines'], 'defines.')
else:
    for q in a:
        cn, _, mn = q.partition('.')
        for c in d['classes']:
            if c['name'] != cn: continue
            if not mn:
                print(cn, ':', c['description'][:500])
                print(' methods:', ', '.join(m['name'] for m in c['methods']))
                print(' attrs:', ', '.join(m['name'] for m in c['attributes']))
            for m in c['methods']:
                if m['name'] == mn: show_method(m)
            for m in c['attributes']:
                if m['name'] == mn:
                    print(f"  {cn}.{mn}: R={typ(m['read_type']) if m.get('read_type') else '-'} W={typ(m['write_type']) if m.get('write_type') else '-'}{' optional' if m.get('optional') else ''}")
                    print('    ' + m.get('description', '').replace('\n', '\n    ')[:1500])
                    if m.get('subclasses'): print('    subclasses:', m['subclasses'])
