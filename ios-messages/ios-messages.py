#!/usr/bin/env python3
"""Pull, export, classify and anonymize text messages from an iPhone backup.

Usage:
  ios-messages.py [--work DIR] extract [--list] [--backup DIR] [--password-env VAR]
  ios-messages.py [--work DIR] export [--out DIR]
  ios-messages.py [--work DIR] classify
  ios-messages.py [--work DIR] anonymize
  ios-messages.py [--work DIR] audit
  ios-messages.py [--work DIR] pipeline [--refresh] [--export]
"""
from ios_messages.cli import main

main()
