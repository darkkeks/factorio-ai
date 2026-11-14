#!/bin/sh
# Сеть робота (172.31.250.0/24, мост br-robot): в интернет можно, к хосту и к другим контейнерам — нельзя.
add() { chain=$1; shift; iptables -C "$chain" "$@" 2>/dev/null || iptables -I "$chain" "$@"; }
iptables -N DOCKER-USER 2>/dev/null
# К другим контейнерам и частным сетям (в том числе через опубликованные на хосте порты).
add DOCKER-USER -s 172.31.250.0/24 -d 10.0.0.0/8 -j DROP
add DOCKER-USER -s 172.31.250.0/24 -d 172.16.0.0/12 -j DROP
add DOCKER-USER -s 172.31.250.0/24 -d 192.168.0.0/16 -j DROP
add DOCKER-USER -s 172.31.250.0/24 -d 169.254.0.0/16 -j DROP
# К самому хосту: новые соединения запрещены, ответы на соединения хоста разрешены.
add INPUT -i br-robot -j DROP
add INPUT -i br-robot -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
