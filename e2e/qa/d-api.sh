#!/bin/bash
# usage: d-api.sh <method-path-or-resource> [query]
SID=$(cat /tmp/ccsid)
curl -s "https://cloudchaserz.frappe.cloud/api/method/$1$2" -H "Cookie: sid=$SID"
