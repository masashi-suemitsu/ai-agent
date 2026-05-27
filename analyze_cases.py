#!/usr/bin/env python3
import json

with open('/tmp/cases.json') as f:
    data = json.load(f)['data']

keywords = ['ゲーム', 'game', 'Game', 'UI', 'UX', 'プランナー', 'ディレクター',
            'アート', 'デザイン', '仕様', 'QA', 'QC', 'コンテンツ', 'エンタメ', '映像']

active_statuses = ['商談中', '提案中', '募集中', '進行中']

print(f"全案件数: {len(data)}")

active = [d for d in data if d.get('anken_status') in active_statuses]
print(f"進行中ステータス: {len(active)}")

matched = [d for d in data if any(k.lower() in (d.get('anken_name') or '').lower() for k in keywords)]
print(f"キーワードマッチ: {len(matched)}")

print()
print("=== ゲーム・UI/UX・デザイン系 キーワードマッチ案件 ===")
for d in matched:
    print(f"[{d.get('anken_status','')}] {d.get('anken_name','')} / {d.get('sales_person','')}")

print()
print("=== 進行中ステータス 全件 ===")
for d in active:
    print(f"[{d.get('anken_status','')}] {d.get('anken_name','')} / {d.get('sales_person','')}")

print()
print("=== 全ステータス種別 ===")
from collections import Counter
c = Counter(d.get('anken_status','') for d in data)
for k, v in c.most_common():
    print(f"  {k}: {v}件")
