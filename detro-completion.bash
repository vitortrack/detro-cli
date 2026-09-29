# Autocomplete Bash da DETRO CLI.

_detro_completion() {
    local current
    local previous
    local command
    local subcommand
    local commands

    COMPREPLY=()

    current="${COMP_WORDS[COMP_CWORD]}"
    previous="${COMP_WORDS[COMP_CWORD - 1]}"
    command="${COMP_WORDS[1]}"
    subcommand="${COMP_WORDS[2]}"

    commands="
        start
        restart
        rebuild
        logs
        status
        stop
        clean
        execute
        hot-reload
        auto-remove
        worker
        ai
        plan
        apply
        check
        fix
        menu
        help
        version
    "

    if [[ ${COMP_CWORD} -eq 1 ]]; then
        COMPREPLY=(
            $(compgen \
                -W "${commands}" \
                -- "${current}")
        )

        return 0
    fi

    case "${command}" in

        ai)
            if [[ ${COMP_CWORD} -eq 2 ]]; then
                COMPREPLY=(
                    $(compgen \
                        -W "status models provider model ctx ask selftest perfil help" \
                        -- "${current}")
                )

                return 0
            fi

            if [[
                "${subcommand}" == "provider" &&
                ${COMP_CWORD} -eq 3
            ]]; then
                COMPREPLY=(
                    $(compgen \
                        -W "ollama" \
                        -- "${current}")
                )

                return 0
            fi
            ;;

        plan)
            if [[ "${current}" == -* ]]; then
                COMPREPLY=(
                    $(compgen \
                        -W "--revalidar" \
                        -- "${current}")
                )
            fi

            return 0
            ;;

        check)
            if [[ "${current}" == -* ]]; then
                COMPREPLY=(
                    $(compgen \
                        -W "--ia --tudo" \
                        -- "${current}")
                )
            else
                COMPREPLY=($(compgen -f -- "${current}"))
            fi
            ;;

        fix)
            COMPREPLY=($(compgen -f -- "${current}"))
            ;;

        menu)
            if [[ ${COMP_CWORD} -eq 2 ]]; then
                COMPREPLY=(
                    $(compgen \
                        -W "listar mover renomear icone permissao" \
                        -- "${current}")
                )
            elif [[ "${current}" == -* ]]; then
                COMPREPLY=(
                    $(compgen \
                        -W "--permissao" \
                        -- "${current}")
                )
            fi
            ;;

        apply)
            if [[ "${current}" == -* ]]; then
                COMPREPLY=(
                    $(compgen \
                        -W "--dry-run --sim --sem-banco --sem-restart" \
                        -- "${current}")
                )
            fi
            ;;

        start|restart|rebuild)
            if [[ "${current}" == -* ]]; then
                COMPREPLY=(
                    $(compgen \
                        -W "--force --no-cache --logs" \
                        -- "${current}")
                )
            fi
            ;;

        logs)
            if [[ "${current}" == -* ]]; then
                COMPREPLY=(
                    $(compgen \
                        -W "--follow --tail" \
                        -- "${current}")
                )
            fi
            ;;

        execute)
            if [[ "${current}" == -* ]]; then
                COMPREPLY=(
                    $(compgen \
                        -W "--force" \
                        -- "${current}")
                )
            fi
            ;;

        stop|clean|hot-reload|auto-remove)
            if [[ "${current}" == -* ]]; then
                COMPREPLY=(
                    $(compgen \
                        -W "--force" \
                        -- "${current}")
                )
            fi
            ;;

        worker)
            if [[ "${current}" == -* ]]; then
                COMPREPLY=(
                    $(compgen \
                        -W "--force --no-cache" \
                        -- "${current}")
                )
            fi
            ;;
    esac
}

complete -F _detro_completion detro