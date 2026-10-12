# Glang

A statically typed, manually managed systems language with a self-hosting compiler, dual execution backends and a deliberately small runtime.

The production compiler — lexer, parser, typed AST, loader, semantic analysis and C emitter — is written in Glang itself and can bootstrap from a committed C seed using only a C compiler. The tree-walking reference interpreter and compiled backend are kept in lockstep through differential testing. The language includes classes, interfaces with vtable dispatch, monomorphised generics, tagged unions and pattern matching, nullable types, exceptions, closures, modules and an increasingly substantial standard library.

